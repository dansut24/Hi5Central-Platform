#include "../src/hi5stream154/user_capture_policy535.hpp"
#include <cassert>
#include <iostream>
int main(){
    using namespace hi5stream;
    assert(AllowUserWgc535("DESKTOP-Q9LTF1M",true,false,0,30,true));
    assert(AllowUserWgc535("DESKTOP-Q9LTF1M",true,false,0,60,true));
    assert(!AllowUserWgc535("DESKTOP-Q9LTF1M",false,false,0,30,true));
    assert(!AllowUserWgc535("OTHER",true,false,0,30,true));
    assert(!AllowUserWgc535("DESKTOP-Q9LTF1M",true,true,0,30,true));
    assert(!AllowUserWgc535("DESKTOP-Q9LTF1M",true,false,1,30,true));
    assert(!AllowUserWgc535("DESKTOP-Q9LTF1M",true,false,0,20,true));
    assert(!AllowUserWgc535("DESKTOP-Q9LTF1M",true,false,0,30,false));
    assert(ValidWgc535I420(1280,800,1024000,256000,256000));
    assert(!ValidWgc535I420(2560,1600,1024000,256000,256000));
    assert(!ValidWgc535I420(1280,800,1024000,1,256000));
    assert(PreferWgc535(true,false,false,0));
    assert(!PreferWgc535(false,false,false,0));
    assert(!PreferWgc535(true,true,false,0));
    assert(!PreferWgc535(true,false,true,0));
    assert(!PreferWgc535(true,false,false,1));
    std::cout << "HI5STREAM535_USER_WGC_POLICY_PASS\n";
}
