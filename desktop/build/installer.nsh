; Orchestra installer hook (electron-builder includes build/installer.nsh automatically).
; LibreOffice is needed to read legacy .doc/.xls/.ppt attachments → installed with Orchestra when missing.
; Rules: never on auto-update (--updated) or silent installs (/S — the user didn't see a question);
; ask first (it is a separate ~350 MB program); failure never fails the Orchestra install (the app asks again later).
!include FileFunc.nsh

!macro customInstall
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    Goto orch_lo_done
  ${EndIf}
  ${If} ${Silent}
    Goto orch_lo_done
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\LibreOffice\program\soffice.exe"
  ${OrIf} ${FileExists} "$PROGRAMFILES32\LibreOffice\program\soffice.exe"
    Goto orch_lo_done
  ${EndIf}
  ; winget ships with Windows 10 1809+ / 11 (App Installer); missing → skip, the app offers the install later
  nsExec::ExecToStack 'cmd.exe /c where winget.exe'
  Pop $R2
  Pop $R3
  ${If} $R2 != 0
    Goto orch_lo_done
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "Orchestra uses LibreOffice (free, ~350 MB) to read old .doc / .xls / .ppt files.$\r$\n$\r$\nInstall LibreOffice now? Windows may ask for administrator rights.$\r$\n$\r$\n(You can skip — Orchestra will offer it again the first time you attach such a file.)" /SD IDNO IDNO orch_lo_done
  DetailPrint "Installing LibreOffice via winget…"
  nsExec::ExecToLog 'winget.exe install --id TheDocumentFoundation.LibreOffice -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity'
  Pop $R2
  ${IfNot} ${FileExists} "$PROGRAMFILES64\LibreOffice\program\soffice.exe"
    MessageBox MB_OK|MB_ICONINFORMATION "LibreOffice was not installed (winget exit code $R2). Orchestra still works; it will offer the install again when you attach an old Office file." /SD IDOK
  ${EndIf}
  orch_lo_done:
!macroend
