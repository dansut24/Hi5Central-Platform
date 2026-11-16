#include "../src/bgra_to_i420_fast.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <random>
#include <vector>

static std::uint8_t LegacyClamp(int v) {
    return static_cast<std::uint8_t>(std::max(0,std::min(255,v)));
}
static void Legacy(
        const std::uint8_t* src, int stride, int width, int height,
        std::vector<std::uint8_t>& y,
        std::vector<std::uint8_t>& u,
        std::vector<std::uint8_t>& v) {
    y.resize(static_cast<std::size_t>(width)*height);
    u.resize(static_cast<std::size_t>((width+1)/2)*((height+1)/2));
    v.resize(u.size());
    for(int py=0;py<height;++py) {
        const auto* row=src+static_cast<std::size_t>(py)*stride;
        for(int x=0;x<width;++x){
            const int b=row[x*4],g=row[x*4+1],r=row[x*4+2];
            y[static_cast<std::size_t>(py)*width+x]=LegacyClamp(
                ((66*r+129*g+25*b+128)>>8)+16);
        }
    }
    for(int by=0;by<(height+1)/2;++by){
        for(int bx=0;bx<(width+1)/2;++bx){
            int sumU=0,sumV=0,count=0;
            for(int dy=0;dy<2;++dy){
                for(int dx=0;dx<2;++dx){
                    const int x=bx*2+dx,py=by*2+dy;
                    if(x>=width||py>=height)continue;
                    const auto* p=src+static_cast<std::size_t>(py)*stride+x*4;
                    const int b=p[0],g=p[1],r=p[2];
                    sumU+=((-38*r-74*g+112*b+128)>>8)+128;
                    sumV+=((112*r-94*g-18*b+128)>>8)+128;
                    ++count;
                }
            }
            const auto index=static_cast<std::size_t>(by)*((width+1)/2)+bx;
            u[index]=LegacyClamp(sumU/std::max(1,count));
            v[index]=LegacyClamp(sumV/std::max(1,count));
        }
    }
}
static void Check(int width,int height,int pad,std::uint32_t seed) {
    const int stride=width*4+pad;
    std::vector<std::uint8_t> src(static_cast<std::size_t>(stride)*height);
    std::mt19937 generator(seed);
    for(auto& b:src)b=static_cast<std::uint8_t>(generator()&255u);
    std::vector<std::uint8_t> legacyY,legacyU,legacyV;
    Legacy(src.data(),stride,width,height,legacyY,legacyU,legacyV);
    std::vector<std::uint8_t> y(legacyY.size()),u(legacyU.size()),v(legacyV.size());
    assert(hi5::BgraToI420FastPlanes(src.data(),stride,width,height,
                                     y.data(),u.data(),v.data()));
    assert(y==legacyY && "Y plane differs from qualified scalar");
    assert(u==legacyU && "U plane differs from qualified scalar");
    assert(v==legacyV && "V plane differs from qualified scalar");
}
int main(){
    for(const int width : {1,2,3,4,5,7,8,13,16,17,31,64,127,320,321,640}){
        for(const int height : {1,2,3,5,7,16,17,64,105}){
            for(const int pad : {0,4,16})
                Check(width,height,pad,
                      static_cast<std::uint32_t>(width*997+height*7+pad));
        }
    }
    Check(2560,1600,0,20261116u);
    assert(!hi5::BgraToI420FastPlanes(nullptr,10240,2560,1600,
                                      nullptr,nullptr,nullptr));
    std::cout << "bgra_to_i420_fast_test PIXEL_EXACT_PASS fixtures=432 "
                 "resolution=2560x1600 coeffs=legacy\n";
    return 0;
}
