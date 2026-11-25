"""华为云 SIS 语音服务封装：构造期初始化、可用性三态与调用单点。

SIS 调用收敛在本模块，测试替身通过注入/猴补该单点实现；
凭证只经 Settings → SpeechService 内存引用链，不落盘、不进响应与日志。
"""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from threading import local

from backend.infra.config import SIS_REGION_ENDPOINTS, Settings

CONNECT_TIMEOUT_SECONDS = 3
READ_TIMEOUT_SECONDS = 8
EXECUTOR_MAX_WORKERS = 2
CALL_TIMEOUT_SECONDS = CONNECT_TIMEOUT_SECONDS + READ_TIMEOUT_SECONDS + 0.5

TTS_AUDIO_FORMAT = "mp3"
TTS_SAMPLE_RATE = "16000"
TTS_SPEED = -40

ASR_AUDIO_FORMAT = "auto"
ASR_PROPERTY = "chinese_16k_general"
ASR_ADD_PUNC = "yes"

DISABLED_REASONS = ("incomplete_credentials", "region_unsupported", "client_init_failed")


class SpeechServiceError(Exception):
    """SIS 上游调用失败：按类别转换后交给路由层转错误包封。"""

    def __init__(self, category: str) -> None:
        self.category = category
        super().__init__(category)


class SpeechConfig:
    """凭证四项与区域映射的只读视图（不做序列化面）。"""

    def __init__(self, region: str, project_id: str, access_key: str, secret_key: str) -> None:
        self._region = region
        self._project_id = project_id
        self._access_key = access_key
        self._secret_key = secret_key

    def endpoint(self) -> str | None:
        return SIS_REGION_ENDPOINTS.get(self._region)

    def is_region_supported(self) -> bool:
        return self._region in SIS_REGION_ENDPOINTS

    def is_complete(self) -> bool:
        return bool(self._project_id) and bool(self._access_key) and bool(self._secret_key)

    def credential_tuple(self) -> tuple[str, str, str]:
        return self._access_key, self._secret_key, self._project_id


class SpeechService:
    """构造期完成凭证/区域/客户端初始化；失败只停用语音，不阻塞应用启动。"""

    def __init__(self, settings: Settings) -> None:
        self._tts_voice = settings.sis_tts_voice
        self._config = SpeechConfig(
            settings.sis_region,
            settings.sis_project_id,
            settings.sis_ak,
            settings.sis_sk,
        )
        self._executor = ThreadPoolExecutor(
            max_workers=EXECUTOR_MAX_WORKERS, thread_name_prefix="cmk-speech"
        )
        self._client = None
        self.available = False
        self.disabled_reason = ""
        self._call_context = local()
        self._initialize()

    def _initialize(self) -> None:
        if not self._config.is_complete():
            self.disabled_reason = "incomplete_credentials"
            return
        if not self._config.is_region_supported():
            self.disabled_reason = "region_unsupported"
            return
        try:
            self._client = self._build_client()
        except Exception:
            self._client = None
            self.disabled_reason = "client_init_failed"
            return
        self.available = True
        self.disabled_reason = ""

    def _build_client(self):
        from huaweicloudsdkcore.auth.credentials import BasicCredentials
        from huaweicloudsdkcore.http.http_config import HttpConfig
        from huaweicloudsdksis.v1 import SisClient

        http_config = HttpConfig.get_default_config()
        http_config.timeout = (CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS)
        access_key, secret_key, project_id = self._config.credential_tuple()
        credentials = BasicCredentials(access_key, secret_key, project_id)
        return (
            SisClient.new_builder()
            .with_credentials(credentials)
            .with_endpoint(f"https://{self._config.endpoint()}")
            .with_http_config(http_config)
            .build()
        )

    def recognize(self, audio_base64: str) -> str:
        """一句话识别：Base64 音频 → 转写文本（同步阻塞，内部限时）。"""
        if not self.available or self._client is None:
            raise SpeechServiceError("speech_disabled")
        request = self._build_recognize_request(audio_base64)
        response = self._submit(self._call_recognize, request)
        self._capture_trace_id(response)
        result = getattr(response, "result", None)
        text = (getattr(result, "text", None) or "").strip()
        return text

    def synthesize(self, text: str) -> bytes:
        """语音合成：老师回复文本 → MP3 字节（同步阻塞，内部限时）。"""
        if not self.available or self._client is None:
            raise SpeechServiceError("speech_disabled")
        request = self._build_synthesize_request(text)
        response = self._submit(self._call_synthesize, request)
        self._capture_trace_id(response)
        result = getattr(response, "result", None)
        data = getattr(result, "data", None) or ""
        try:
            audio = base64.b64decode(data, validate=True) if data else b""
        except Exception as exc:
            raise SpeechServiceError("upstream") from exc
        if not audio:
            raise SpeechServiceError("upstream")
        return audio

    def _build_recognize_request(self, audio_base64: str):
        from huaweicloudsdksis.v1 import RecognizeShortAudioRequest
        from huaweicloudsdksis.v1.model import Config, PostShortAudioReq

        config = Config(
            audio_format=ASR_AUDIO_FORMAT,
            _property=ASR_PROPERTY,
            add_punc=ASR_ADD_PUNC,
        )
        return RecognizeShortAudioRequest(
            body=PostShortAudioReq(config=config, data=audio_base64)
        )

    def _build_synthesize_request(self, text: str):
        from huaweicloudsdksis.v1 import RunTtsRequest
        from huaweicloudsdksis.v1.model import PostCustomTTSReq, TtsConfig

        config = TtsConfig(
            audio_format=TTS_AUDIO_FORMAT,
            sample_rate=TTS_SAMPLE_RATE,
            _property=self._tts_voice,
            speed=TTS_SPEED,
        )
        return RunTtsRequest(body=PostCustomTTSReq(text=text, config=config))

    def _submit(self, call, request):
        future = self._executor.submit(call, request)
        try:
            return future.result(timeout=CALL_TIMEOUT_SECONDS)
        except FutureTimeoutError as exc:
            future.cancel()
            raise SpeechServiceError("timeout") from exc
        except SpeechServiceError:
            raise
        except Exception as exc:
            raise SpeechServiceError("upstream") from exc

    def _call_recognize(self, request):
        try:
            return self._client.recognize_short_audio(request)
        except Exception as exc:
            raise SpeechServiceError(self._classify(exc)) from exc

    def _call_synthesize(self, request):
        try:
            return self._client.run_tts(request)
        except Exception as exc:
            raise SpeechServiceError(self._classify(exc)) from exc

    @property
    def last_cloud_trace_id(self) -> str:
        return getattr(self._call_context, "trace_id", "")

    def _capture_trace_id(self, response) -> None:
        self._call_context.trace_id = str(
            getattr(response, "trace_id", None)
            or getattr(response, "x_request_id", None)
            or getattr(response, "response_id", None)
            or ""
        )

    @staticmethod
    def _classify(exc: Exception) -> str:
        name = type(exc).__name__.lower()
        if "timeout" in name:
            return "timeout"
        if "connection" in name or "connect" in name:
            return "connection"
        return "upstream"
