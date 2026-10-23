Unicode true
!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!ifndef APP_DIR
  !error "APP_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef UNINSTALL_LIST
  !error "UNINSTALL_LIST is required"
!endif
Name "Codex Co²"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Codex Co2"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Codex Co² — Real-time collaboration for Codex"
!define MUI_ICON "AppIcon.ico"
!define MUI_UNICON "AppIcon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This Codex Co² package requires 64-bit Windows."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Codex Co² requires Windows 10 version 1809 or later."
    Abort
  ${EndIf}
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  IntCmp $0 17763 version_ok version_old version_ok
  version_old:
    MessageBox MB_ICONSTOP "Codex Co² requires Windows 10 version 1809 (build 17763) or later."
    Abort
  version_ok:
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\CodexCo2.Manager") p .r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_ICONSTOP "Quit Codex Co² from the notification area before installing an update."
    Abort
  ${EndIf}
FunctionEnd
Section "Codex Co²"
  SetShellVarContext current
  SetRegView 64
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Codex Co2"
  CreateShortcut "$SMPROGRAMS\Codex Co2\Codex Co².lnk" "$INSTDIR\CodexCo2.exe"
  CreateShortcut "$SMPROGRAMS\Codex Co2\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2" "DisplayName" "Codex Co²"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2" "DisplayIcon" "$INSTDIR\CodexCo2.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2" "NoRepair" 1
SectionEnd
Function un.onInit
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\CodexCo2.Manager") p .r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_ICONSTOP "Quit Codex Co² before uninstalling it."
    Abort
  ${EndIf}
FunctionEnd
Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  Delete "$SMPROGRAMS\Codex Co2\Codex Co².lnk"
  Delete "$SMPROGRAMS\Codex Co2\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Codex Co2"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexCo2"
  ; Private .coop state is outside the installation and is preserved.
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
