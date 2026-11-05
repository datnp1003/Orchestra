; Orchestra installer hook (electron-builder includes build/installer.nsh automatically; assisted installer, oneClick=false).
; Components page: Orchestra (required) · LibreOffice (reads legacy .doc/.xls/.ppt; preselected only when missing) · Desktop shortcut.
; The checkbox is the consent for LibreOffice. Never on auto-update (--updated, pages skipped) or silent installs (/S).
; LibreOffice failing never fails the Orchestra install — the app offers it again on the first legacy attachment.
; ponytail: page texts are English only — add LangString per installer language if the installer gets localized.
!include Sections.nsh

!ifndef BUILD_UNINSTALLER
  ; flag sections — empty bodies; the work happens in customInstall (inside electron-builder's "install" section, declared after these)
  Section "Orchestra Desktop (required)" ORCH_SEC_APP
    SectionIn RO
  SectionEnd
  Section "LibreOffice (old .doc/.xls/.ppt, ~350 MB)" ORCH_SEC_LO
    AddSize 358400 ; KB — downloaded by winget, counted so "Space required" is honest
  SectionEnd
  Section "Desktop shortcut" ORCH_SEC_DESKTOP
  SectionEnd
!endif

!macro customPageAfterChangeDir
  ; electron-builder pre-defines MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre for the INSTFILES page that follows this hook:
  ; park it, use our own pre (skip on update) for the components page, then restore it for INSTFILES
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define /redef ORCH_INSTFILES_PRE "${MUI_PAGE_CUSTOMFUNCTION_PRE}"
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !insertmacro skipPageIfUpdated
  !define MUI_COMPONENTSPAGE_NODESC
  !insertmacro MUI_PAGE_COMPONENTS
  !ifdef ORCH_INSTFILES_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE "${ORCH_INSTFILES_PRE}"
  !endif
!macroend

!macro orchHasLibreOffice _out
  StrCpy ${_out} "0"
  ${If} ${FileExists} "$PROGRAMFILES64\LibreOffice\program\soffice.exe"
  ${OrIf} ${FileExists} "$PROGRAMFILES32\LibreOffice\program\soffice.exe"
    StrCpy ${_out} "1"
  ${EndIf}
!macroend

!macro customInit
  ; electron-builder's own section is declared after ours (index 3) — hide it, our "required" row stands in for it.
  ; Guarded by its name so a template change can never hide the wrong row.
  SectionGetText 3 $R0
  ${If} $R0 == "install"
    SectionSetText 3 ""
  ${EndIf}
  !insertmacro orchHasLibreOffice $R0
  nsExec::ExecToStack 'cmd.exe /c where winget.exe'
  Pop $R1
  Pop $R2
  ${If} $R0 == "1"
    SectionSetText ${ORCH_SEC_LO} "LibreOffice (already installed)"
    SectionSetFlags ${ORCH_SEC_LO} ${SF_RO}
  ${ElseIf} $R1 != 0
    SectionSetText ${ORCH_SEC_LO} "LibreOffice (needs winget — install manually)"
    SectionSetFlags ${ORCH_SEC_LO} ${SF_RO}
  ${Else}
    SectionSetFlags ${ORCH_SEC_LO} ${SF_SELECTED}
  ${EndIf}
  SectionSetFlags ${ORCH_SEC_DESKTOP} ${SF_SELECTED}
!macroend

!macro customInstall
  ${If} ${isUpdated}
  ${OrIf} ${Silent}
    Goto orch_done
  ${EndIf}
  ; electron-builder already created the desktop link (addDesktopLink) — remove it when unticked
  ${IfNot} ${SectionIsSelected} ${ORCH_SEC_DESKTOP}
    Delete "$newDesktopLink"
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${ORCH_SEC_LO}
    Goto orch_done
  ${EndIf}
  DetailPrint "Installing LibreOffice via winget (a few minutes)…"
  nsExec::ExecToLog 'winget.exe install --id TheDocumentFoundation.LibreOffice -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity'
  Pop $R2
  !insertmacro orchHasLibreOffice $R0
  ${If} $R0 == "1"
    DetailPrint "LibreOffice installed"
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "LibreOffice was not installed (winget exit code $R2). Orchestra still works; it will offer the install again when you attach an old Office file." /SD IDOK
  ${EndIf}
  orch_done:
!macroend
