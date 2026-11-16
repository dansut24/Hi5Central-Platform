#include "../src/gdi_direct_1080_policy.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <tuple>
int main() {
 using hi5::GdiDirectTarget1080;
 using hi5::GdiDirectEligible;
 auto n=GdiDirectTarget1080(2560,1600,false);
 assert(n.width==2560 && n.height==1600 && !n.scaled);
 auto a=GdiDirectTarget1080(2560,1600,true);
 assert(a.width==1728 && a.height==1080 && a.scaled);
 auto b=GdiDirectTarget1080(3840,2160,true);
 assert(b.width==1920 && b.height==1080 && b.scaled);
 auto c=GdiDirectTarget1080(1920,1200,true);
 assert(c.width==1728 && c.height==1080 && c.scaled);
 auto d=GdiDirectTarget1080(1366,768,true);
 assert(d.width==1366 && d.height==768 && !d.scaled);
 assert(!GdiDirectEligible(true,true,-1,false));
 assert(!GdiDirectEligible(true,true,1,false));
 assert(!GdiDirectEligible(true,false,0,false));
 assert(!GdiDirectEligible(true,true,0,true));
 assert(!GdiDirectEligible(false,true,0,false));
 assert(GdiDirectEligible(true,true,0,false));
 for(auto [w,h]:{std::tuple<int,int>{1921,1081},{2560,1600},
  {3440,1440},{3840,2160},{2001,1535},{1024,2048},{16384,3000}}){
   auto t=GdiDirectTarget1080(w,h,true);
   assert(t.scaled && t.width>=2 && t.height>=2);
   assert(t.width<=1920 && t.height<=1080);
   assert((t.width%2)==0 && (t.height%2)==0);
   assert(t.width<=w && t.height<=h);
   assert(std::abs(static_cast<double>(t.width)/t.height-
             static_cast<double>(w)/h)<0.01);
 }
 auto x=GdiDirectTarget1080(0,1080,true);assert(x.width==0);
 std::cout<<"gdi_direct_1080_policy_test PASS 2560x1600_to_1728x1080"
             " input_geometry=unchanged secure_fallback=1\n";
 return 0;
}
