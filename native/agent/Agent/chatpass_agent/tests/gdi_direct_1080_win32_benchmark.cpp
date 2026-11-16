#ifdef _WIN32
#include "../src/gdi_direct_1080_policy.h"
#include <windows.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <vector>
#pragma comment(lib,"gdi32.lib")

namespace {
struct Dib {
    HDC dc=nullptr;
    HBITMAP bmp=nullptr;
    HGDIOBJ old=nullptr;
    unsigned char* bytes=nullptr;
    int w=0,h=0;
    Dib(int width,int height):w(width),h(height) {
        dc=CreateCompatibleDC(nullptr);
        BITMAPINFO info{};
        info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth=w;
        info.bmiHeader.biHeight=-h;
        info.bmiHeader.biPlanes=1;
        info.bmiHeader.biBitCount=32;
        info.bmiHeader.biCompression=BI_RGB;
        void* ptr=nullptr;
        if(dc)bmp=CreateDIBSection(dc,&info,DIB_RGB_COLORS,&ptr,nullptr,0);
        bytes=static_cast<unsigned char*>(ptr);
        if(dc && bmp)old=SelectObject(dc,bmp);
    }
    ~Dib(){
        if(dc && old)SelectObject(dc,old);
        if(bmp)DeleteObject(bmp);
        if(dc)DeleteDC(dc);
    }
    bool valid()const{return dc&&bmp&&bytes&&old&&old!=HGDI_ERROR;}
};
}
int main(){
    const auto size=hi5::GdiDirectTarget1080(2560,1600,true);
    if(size.width!=1728 || size.height!=1080)return 1;
    Dib src(2560,1600),native(2560,1600),scaled(size.width,size.height);
    if(!src.valid()||!native.valid()||!scaled.valid())return 2;
    const std::size_t srcPixels=static_cast<std::size_t>(src.w)*src.h;
    for(std::size_t i=0;i<srcPixels;++i){
        src.bytes[i*4+0]=33;
        src.bytes[i*4+1]=111;
        src.bytes[i*4+2]=222;
        src.bytes[i*4+3]=0;
    }
    SetStretchBltMode(scaled.dc,COLORONCOLOR);
    using clock=std::chrono::steady_clock;
    double fullMs=0,directMs=0;
    for(int i=0;i<12;++i) {
        const auto start=clock::now();
        if(!BitBlt(native.dc,0,0,2560,1600,src.dc,0,0,SRCCOPY))return 3;
        fullMs+=std::chrono::duration<double,std::milli>(clock::now()-start).count();
        const auto down=clock::now();
        if(!StretchBlt(scaled.dc,0,0,size.width,size.height,
                       src.dc,0,0,2560,1600,SRCCOPY))return 4;
        directMs+=std::chrono::duration<double,std::milli>(clock::now()-down).count();
    }
    for(const int x : {0,5,137,1000,size.width-1}){
        for(const int y : {0,7,127,size.height-1}){
            const auto idx=(static_cast<std::size_t>(y)*size.width+x)*4;
            if(scaled.bytes[idx]!=33 || scaled.bytes[idx+1]!=111 ||
               scaled.bytes[idx+2]!=222)return 5;
        }
    }
    std::cout<<"gdi_direct_1080_win32_benchmark PASS src=2560x1600"
             <<" dst=1728x1080 GDI=StretchBlt COLORONCOLOR"
             <<" native_ms="<<(fullMs/12)<<" direct_ms="<<(directMs/12)
             <<" synthetic_memory_DIB_only=1 screen_capture_fps_unproven=1\n";
    return 0;
}
#else
int main(){return 0;}
#endif
