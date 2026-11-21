#include "../src/streamcore_v048_cpu_policy.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace hi5::streamcore048;
static void require(bool condition,const char* m){if(!condition)throw std::runtime_error(m);}
int main() {
 require(!NativeBlit(false,1920,1080,1920,1080),"default off");
 require(NativeBlit(true,1920,1080,1920,1080),"native size path");
 require(!NativeBlit(true,1920,1080,1280,720),"scaled fallback");
 require(!NativeBlit(true,0,1080,0,1080),"zero rejected");
 std::vector<uint8_t> b(1920*1080*4,2),a=b;
 require(ExactSameBGRA(a.data(),a.size(),b.data(),b.size()),"identical");
 b.back()=3;require(!ExactSameBGRA(a.data(),a.size(),b.data(),b.size()),"one byte at final pixel");
 b.back()=2;require(ExactSameBGRA(a.data(),a.size(),b.data(),b.size()),"identical restored");
 require(!ExactSameBGRA(a.data(),a.size(),b.data(),b.size()-4),"size changed");
 auto t=std::chrono::steady_clock::time_point{}+std::chrono::seconds(10);
 require(!HeartbeatDue(t+std::chrono::milliseconds(499),t),"no early extra frame");
 require(HeartbeatDue(t+std::chrono::milliseconds(500),t),"500ms heartbeat");
 std::cout<<"PASS: production RMM v048 CPU policy native blit, exact 1-byte change, scaled fallback, and 500ms heartbeat\n";
}
