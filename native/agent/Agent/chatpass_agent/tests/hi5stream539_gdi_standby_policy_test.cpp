#include "../src/hi5stream154/gdi_standby539_policy.hpp"
#include <cassert>
#include <iostream>
int main(){
    using hi5stream::ShouldStandbyGdi539;
    const auto pass=ShouldStandbyGdi539(true,true,true,true,false,false,false,0,0);
    assert(pass);
    assert(ShouldStandbyGdi539(true,true,true,true,false,false,false,0,219));
    assert(!ShouldStandbyGdi539(true,true,true,true,false,false,false,0,220));
    assert(!ShouldStandbyGdi539(true,true,true,true,false,false,false,0,-1));
    assert(!ShouldStandbyGdi539(false,true,true,true,false,false,false,0,10));
    assert(!ShouldStandbyGdi539(true,false,true,true,false,false,false,0,10));
    assert(!ShouldStandbyGdi539(true,true,false,true,false,false,false,0,10));
    assert(!ShouldStandbyGdi539(true,true,true,false,false,false,false,0,10));
    assert(!ShouldStandbyGdi539(true,true,true,true,true,false,false,0,10));
    assert(!ShouldStandbyGdi539(true,true,true,true,false,true,false,0,10));
    assert(!ShouldStandbyGdi539(true,true,true,true,false,false,true,0,10));
    assert(!ShouldStandbyGdi539(true,true,true,true,false,false,false,1,10));
    std::cout<<"HI5STREAM539_STANDBY_POLICY_PASS: 12 normal/fallback/UAC/expiry conditions\n";
}
