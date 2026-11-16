#include "../src/wgc_live_policy.h"
#include <cassert>
#include <iostream>
int main(){
 using hi5::WgcLiveEligible;
 assert(WgcLiveEligible(true,false,true,true,false,false,0));
 assert(!WgcLiveEligible(false,false,true,true,false,false,0));
 assert(!WgcLiveEligible(true,true,true,true,false,false,0));
 assert(!WgcLiveEligible(true,false,false,true,false,false,0));
 assert(!WgcLiveEligible(true,false,true,false,false,false,0));
 assert(!WgcLiveEligible(true,false,true,true,true,false,0));
 assert(!WgcLiveEligible(true,false,true,true,false,true,0));
 assert(!WgcLiveEligible(true,false,true,true,false,false,-1));
 assert(!WgcLiveEligible(true,false,true,true,false,false,1));
 assert(!WgcLiveEligible(true,false,true,true,false,false,2));
 std::cout<<"wgc_live_policy_test PASS normal_primary_only_secure_fallback=1\n";
 return 0;
}
