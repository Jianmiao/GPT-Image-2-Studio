# GPT Image 2 安卓版

这是可在手机本机运行的 Android 应用。界面与桌面版共享 `web` 目录，网络请求由 Android 原生代码发送，手机不需要启动 Node 服务。

点击「＋ 相册」打开最近照片面板，可展开全屏并按相册分类多选。图片只在提交生成时发给你配置的供应商。没有图片自动文生图，添加图片自动图生图，删除最后一张图片会自动恢复文生图。

照片访问仅在主动选择图片时请求系统授权。Android 14 的“仅选中的照片”权限也可使用；不授权整个相册时，仍可通过系统选择器逐次挑选图片。

设置中可选择深色、浅色或跟随系统。页面、原生相册和系统栏同步配色，主题保存在本机。

## 网络代理

网络代理默认 `auto`，按系统对供应商地址的代理规则连接（包括 PAC 排除规则）。探测显示实际选中的代理地址，或当前应用可见的 VPN 网络；它只识别配置，不代表已连通。“获取模型”和“连通性检测”只发送模型查询，不发送生图请求。

使用 Nano 等 VPN 代理时，需要在代理软件的应用分流中包含 GPT Image 2。仅开启本地 HTTP 代理端口时，可填写 `http://127.0.0.1:实际端口`；连接电脑的代理应填写电脑的局域网地址。`off` 只停用显式代理，Android 系统 VPN 仍可能接管连接。

1.2.2 修复 Android 系统代理返回未解析地址时的 `127.0.0.1` 连接失败，并区分连接代理失败和供应商返回的错误。连接失败不会切换代理或重发生成请求。

## 构建

要求 JDK 17、Android SDK Platform 35、Android SDK Build-Tools 35.0.0。Gradle Wrapper 固定为 8.9，Android Gradle Plugin 固定为 8.7.3。首次构建需要联网下载构建依赖。

Windows PowerShell：

```powershell
$env:JAVA_HOME = 'C:\path\to\jdk-17'
$env:ANDROID_HOME = 'C:\path\to\android-sdk'
.\android\build-apk.ps1
```

也可以通过 `-JdkHome` 和 `-AndroidSdk` 传入路径。此电脑已准备的工具缓存位于用户目录 `.cache/gpt-image2-android-tools`，脚本会自动查找该缓存。`-OutputApk` 可指定输出文件。

其他系统：设置 JDK/SDK 环境变量后，在 `android` 目录运行 `./gradlew :app:assembleDebug`。

构建产物为 `android/app/build/outputs/apk/debug/app-debug.apk`；PowerShell 脚本验证签名后，将它复制到项目根目录的 `GPT-Image-2生图工具.apk`。

## 打包范围

构建时 `syncWebAssets` 仅复制 `web` 中的 HTML、CSS、JavaScript 到 APK 的 `assets/web`。桌面的 `.gptimage2` 配置、API Key、生成图片和历史记录不会打进 APK。`local.properties` 仅保存本机 SDK 路径，已加入忽略清单。

包名：`com.jianmiao.imagestudio`。最低版本：Android 8.0（API 26）。目标版本：Android 15（API 35）。使用系统 Android SDK，无 AndroidX 运行时依赖。

当前构建是使用本机 Android 调试证书签名的可安装 APK。后续覆盖更新需沿用相同证书；公开发布时应使用独立且妥善保存的发布证书。

## 当前实现边界

- 安卓版接收并解析供应商的 SSE 响应，完成后显示最终图片；暂不逐帧显示生成中的预览图。
- APK 已使用 Android 调试证书签名，可直接安装到 Android 8.0 及以上设备；系统可能需要允许本次安装来源。
- 当前环境没有连接的 Android 手机或模拟器，已完成编译、APK 签名校验、JavaScript 桥接及本地网络模拟测试，尚未做真机测试。
