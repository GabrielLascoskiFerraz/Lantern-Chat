Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef SOURCE_EXE
  !error "SOURCE_EXE não informado"
!endif
!ifndef OUTPUT_EXE
  !error "OUTPUT_EXE não informado"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif

Name "Lantern Relay Server"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Programs\Lantern Relay Server"
InstallDirRegKey HKCU "Software\Lantern Relay Server" "InstallDir"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Instalar"
  SetOutPath "$INSTDIR"
  File /oname=LanternRelay.exe "${SOURCE_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Lantern Relay Server" "InstallDir" "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\Lantern Relay Server"
  CreateShortcut "$SMPROGRAMS\Lantern Relay Server\Lantern Relay Server.lnk" "$INSTDIR\LanternRelay.exe"
  CreateShortcut "$SMPROGRAMS\Lantern Relay Server\Desinstalar.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Lantern Relay Server.lnk" "$INSTDIR\LanternRelay.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Lantern Relay Server.lnk"
  Delete "$SMPROGRAMS\Lantern Relay Server\Lantern Relay Server.lnk"
  Delete "$SMPROGRAMS\Lantern Relay Server\Desinstalar.lnk"
  RMDir "$SMPROGRAMS\Lantern Relay Server"
  Delete "$INSTDIR\LanternRelay.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Lantern Relay Server"
SectionEnd
