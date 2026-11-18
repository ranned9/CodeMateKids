import { AbilityConstant, UIAbility, Want } from "@kit.AbilityKit";
import { hilog } from "@kit.PerformanceAnalysisKit";
import { window } from "@kit.ArkUI";

const DOMAIN = 0x0000;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, "CodeMateKids", "基础语言示例启动");
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent("pages/Index", (err) => {
      if (err.code) {
        hilog.error(DOMAIN, "CodeMateKids", "页面加载失败: %{public}s", JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, "CodeMateKids", "页面加载完成");
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, "CodeMateKids", "页面销毁");
  }

  onDestroy(): void {
    hilog.info(DOMAIN, "CodeMateKids", "应用退出");
  }
}