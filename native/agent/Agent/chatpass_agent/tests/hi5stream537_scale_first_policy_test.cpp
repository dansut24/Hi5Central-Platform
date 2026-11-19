#include "../src/hi5stream154/scale_first537_policy.hpp"
#include <cassert>
#include <iostream>
int main(){
    using namespace hi5stream;
    assert(CanUseScaleFirst537("DESKTOP-Q9LTF1M",true,true,true,2560,1600,1280,800,0));
    assert(!CanUseScaleFirst537("DESKTOP-Q9LTF1M",true,true,false,2560,1600,1280,800,0));
    assert(!CanUseScaleFirst537("DESKTOP-Q9LTF1M",false,true,true,2560,1600,1280,800,0));
    assert(!CanUseScaleFirst537("DESKTOP-Q9LTF1M",true,false,true,2560,1600,1280,800,0));
    assert(!CanUseScaleFirst537("OTHER",true,true,true,2560,1600,1280,800,0));
    assert(!CanUseScaleFirst537("DESKTOP-Q9LTF1M",true,true,true,1920,1080,1280,800,0));
    assert(!CanUseScaleFirst537("DESKTOP-Q9LTF1M",true,true,true,2560,1600,1920,1080,0));
    assert(!CanUseScaleFirst537("DESKTOP-Q9LTF1M",true,true,true,2560,1600,1280,800,1));
    assert(IsValidScaleFirst537Stride(2560,1600,10240,1280,800));
    assert(!IsValidScaleFirst537Stride(2560,1600,100,1280,800));
    assert(!IsValidScaleFirst537Stride(2560,1600,10240,1920,1080));
    assert(ExpectedOutputI420Bytes537(1280,800)==1536000);
    assert(ExpectedOutputI420Bytes537(2560,1600)==0);
    std::cout<<"HI5STREAM537_CANARY_POLICY_PASS\n";
}
