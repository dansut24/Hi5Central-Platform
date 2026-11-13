#define MyAppName "Hi5Central Self Service"
#define MyAppVersion "0.2.0"
#define MyAppPublisher "Hi5Central"
#define MyAppExeName "Hi5CentralAppPortal.exe"
#ifndef AppPortalExePath
  #define AppPortalExePath "..\bin\Release\net8.0\win-x64\publish\Hi5CentralAppPortal.exe"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
AppId={{B7F2A5BD-CC0E-4F60-A47D-EB3D9B7D996E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Hi5Central\Self Service
DefaultGroupName=Hi5Central
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Hi5CentralSelfServiceSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#AppPortalExePath}"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Hi5Central\Self Service"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{userdesktop}\Hi5Central Self Service"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Hi5Central Self Service"; Flags: postinstall nowait skipifsilent
