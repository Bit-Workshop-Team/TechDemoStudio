; 技术演示台 - NSIS 安装器自定义脚本
; 由 electron-builder 通过 nsis.include 引入

!include "WinVer.nsh"
!include "LogicLib.nsh"

!macro customInit
  ; 硬性要求：Windows 7 SP1 及以上
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_ICONSTOP|MB_OK "本软件需要 Windows 7 SP1 或更高版本的 Windows。$\r$\n$\r$\n当前系统版本过低，安装已终止。"
    Abort
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "技术演示台安装完成，可在开始菜单或桌面启动。"
!macroend

!macro customUnInstall
  DetailPrint "技术演示台已卸载。用户配置(API Key 等)保留在用户目录，如需彻底清除请手动删除。"
!macroend
