// Real pixel-equivalence/quality and CPU time benchmark for two libyuv paths.
// Run on Windows after restoring vcpkg libyuv. No WebRTC, screen access or service.
#include <libyuv/convert.h>
#include <libyuv/scale.h>
#include <libyuv/scale_argb.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>
int main() {
    const int w=2560,h=1600,dw=1280,dh=800;
    std::vector<uint8_t> bgra(size_t(w)*h*4);
    // deterministic moving-window-like colored checker + typography edges
    for(int y=0;y<h;++y)for(int x=0;x<w;++x) {
        const size_t pos=(size_t(y)*w+x)*4;
        const uint8_t edge=(((x/8)+(y/8))%2)?230:18;
        bgra[pos]=static_cast<uint8_t>((x+y+edge)&255);
        bgra[pos+1]=static_cast<uint8_t>((y/2+edge)&255);
        bgra[pos+2]=static_cast<uint8_t>((x/2+edge)&255);
        bgra[pos+3]=255;
    }
    const size_t fullY=size_t(w)*h,fullUV=size_t(w/2)*(h/2);
    const size_t outY=size_t(dw)*dh,outUV=size_t(dw/2)*(dh/2);
    std::vector<uint8_t> full(fullY+2*fullUV),legacy(outY+2*outUV);
    std::vector<uint8_t> scaledBgra(size_t(dw)*dh*4),fast(outY+2*outUV);
    auto baseline=[&](){
        if(libyuv::ARGBToI420(bgra.data(),w*4,full.data(),w,
            full.data()+fullY,w/2,full.data()+fullY+fullUV,w/2,w,h)!=0)return false;
        return libyuv::I420Scale(full.data(),w,
            full.data()+fullY,w/2,full.data()+fullY+fullUV,w/2,w,h,
            legacy.data(),dw,legacy.data()+outY,dw/2,
            legacy.data()+outY+outUV,dw/2,dw,dh,libyuv::kFilterBilinear)==0;
    };
    auto alternate=[&](){
        if(libyuv::ARGBScale(bgra.data(),w*4,w,h,
                             scaledBgra.data(),dw*4,dw,dh,
                             libyuv::kFilterBilinear)!=0)return false;
        return libyuv::ARGBToI420(scaledBgra.data(),dw*4,fast.data(),dw,
            fast.data()+outY,dw/2,fast.data()+outY+outUV,dw/2,dw,dh)==0;
    };
    if(!baseline()||!alternate()){std::cerr<<"libyuv pipeline failure\n";return 1;}
    double mse=0.0;int maxDelta=0;
    for(size_t i=0;i<legacy.size();++i) {
        const int delta=std::abs(int(legacy[i])-int(fast[i]));
        mse+=double(delta)*delta;maxDelta=std::max(maxDelta,delta);
    }
    mse/=legacy.size();
    const double psnr=mse>0?10*std::log10(255.0*255.0/mse):99.0;
    std::cout<<"pixel_psnr_db="<<psnr<<" max_channel_delta="<<maxDelta<<"\n";
    if(psnr<26.0){std::cerr<<"Alternate pixel quality insufficient\n";return 2;}
    constexpr int runs=12;
    auto measure=[&](auto fn){
        const auto t=std::chrono::steady_clock::now();
        for(int n=0;n<runs;++n)if(!fn())return -1.0;
        const auto done=std::chrono::steady_clock::now();
        return std::chrono::duration<double,std::milli>(done-t).count()/runs;
    };
    const double legacyMs=measure(baseline),alternateMs=measure(alternate);
    std::cout<<"baseline_ms="<<legacyMs<<" scale_first_ms="<<alternateMs
             <<" relative_speedup="<<(legacyMs/alternateMs)<<"\n";
    if(legacyMs<=0||alternateMs<=0)return 3;
    // Performance may be slower on some hardware; report and gate Lenovo canary
    // qualification on on-device results rather than failing CI for a slower runner.
    std::cout<<"HI5STREAM537_LIBYUV_PIXEL_AND_BENCH_PASS\n";
    return 0;
}
