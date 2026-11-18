/**
 * 鸿蒙基础语言示例：变量与类型、表达式、条件、循环、函数、数组/对象、简单交互。
 * 仅用于语言基础验证，不包含应用框架深入内容或设备联动。
 */

@Entry
@Component
struct Index {
  @State steps: number = 0;
  @State message: string = "点一下按钮，让小海龟走一步";

  aboutToAppear(): void {
    this.message = this.buildLanguageSummary();
  }

  // 函数：变量、类型、表达式、循环、数组与对象
  private buildLanguageSummary(): string {
    const title: string = "鸿蒙基础语言示例";
    const numbers: number[] = [1, 2, 3];
    const animal: Record<string, string | number> = { name: "小海龟", goal: 3 };
    let total: number = 0;
    for (let index: number = 0; index < numbers.length; index += 1) {
      total += numbers[index] * 2;
    }
    if (total >= 10) {
      return `${title}：${animal.name} 的目标是 ${animal.goal} 步，准备完成`;
    }
    return `${title}：再准备一下`;
  }

  // 函数：条件判断
  private describeSteps(count: number): string {
    if (count >= 3) {
      return "小海龟到达终点啦，试试说出重复了几次。";
    }
    return `小海龟走了 ${count} 步，还差 ${3 - count} 步。`;
  }

  build() {
    Column({ space: 18 }) {
      Text("基础语言小练习")
        .fontSize(24)
        .fontWeight(FontWeight.Bold)

      Text(this.message)
        .fontSize(15)
        .fontColor("#4a5873")
        .textAlign(TextAlign.Center)

      Text(`当前步数：${this.steps}`)
        .fontSize(20)

      Button("让小海龟走一步")
        .width(220)
        .onClick(() => {
          this.steps += 1;
          this.message = this.describeSteps(this.steps);
        })

      Button("重新开始")
        .width(160)
        .onClick(() => {
          this.steps = 0;
          this.message = this.buildLanguageSummary();
        })
    }
    .width("100%")
    .padding(28)
    .alignItems(HorizontalAlign.Center)
  }
}