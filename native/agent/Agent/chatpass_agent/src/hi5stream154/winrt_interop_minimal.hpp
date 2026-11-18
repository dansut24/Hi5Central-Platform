// Hi5Central compatibility declarations for the public Windows WinRT/Direct3D
// interop COM interfaces. This file is used ONLY for cross-compilation with
// older MinGW Windows headers; MSVC uses the official Windows SDK headers.
// Copyright (c) 2026 Hi5Central. Proprietary integration code.
#pragma once
#ifndef _WIN32
#error Windows-only WinRT interoperability
#endif
#include <windows.h>
#include <unknwn.h>
#include <inspectable.h>
#include <dxgi.h>
struct Hi5CaptureItemInterop : ::IUnknown {
    virtual HRESULT STDMETHODCALLTYPE CreateForWindow(
        HWND window,REFIID iid,void** result)=0;
    virtual HRESULT STDMETHODCALLTYPE CreateForMonitor(
        HMONITOR monitor,REFIID iid,void** result)=0;
};
struct Hi5DxgiSurfaceAccess : ::IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetInterface(
        REFIID iid,void** result)=0;
};
inline constexpr GUID HI5_IID_CAPTURE_ITEM_INTEROP={
    0x3628e81b,0x3cac,0x4c60,{0xb7,0xf4,0x23,0xce,0x0e,0x0c,0x33,0x56}};
inline constexpr GUID HI5_IID_DXGI_SURFACE_ACCESS={
    0xa9b3d012,0x3df2,0x4ee3,{0xb8,0xd1,0x86,0x95,0xf4,0x57,0xd3,0xc1}};
extern "C" HRESULT WINAPI CreateDirect3D11DeviceFromDXGIDevice(
    IDXGIDevice* dxgiDevice,IInspectable** graphicsDevice);
