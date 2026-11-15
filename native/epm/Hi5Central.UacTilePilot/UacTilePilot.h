#pragma once
#include <windows.h>

// Hi5Central EPM proof of concept CLSID. Deliberately distinct from the
// production Agent, Company Portal and EPM service COM registrations.
inline constexpr GUID CLSID_Hi5CentralUacTilePilot =
  {0x7464d2e2,0x202b,0x4546,{0x95,0x3d,0x9a,0xfc,0xda,0x32,0x01,0xe6}};
