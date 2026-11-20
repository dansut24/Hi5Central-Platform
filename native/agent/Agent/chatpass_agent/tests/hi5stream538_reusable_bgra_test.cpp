// Test-only C++17 model for the Newtest 1.0.538 WGC BGRA reusable buffer.
#include <cassert>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <optional>
#include <utility>
#include <vector>
struct Frame { std::vector<uint8_t> pixels; uint64_t id=0; };
struct State {
  std::mutex mutex;
  std::optional<Frame> latest;
  std::vector<uint8_t> recycled;
  uint64_t allocations=0,reuses=0,replacements=0;
};
static void deliver(State& s,uint64_t id,size_t n){
  Frame frame;
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    if(s.recycled.capacity()>=n){
      frame.pixels.swap(s.recycled);++s.reuses;
    }else ++s.allocations;
  }
  frame.pixels.resize(n);
  for(size_t i=0;i<n;++i)frame.pixels[i]=uint8_t((i+id)%251u);
  frame.id=id;
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    if(s.latest) {
      ++s.replacements;
      if(s.latest->pixels.capacity()>s.recycled.capacity())
        s.recycled.swap(s.latest->pixels);
    }
    s.latest=std::move(frame);
  }
}
static std::optional<Frame> receive(State& s){
  std::lock_guard<std::mutex> lock(s.mutex);
  auto result=std::move(s.latest);
  s.latest.reset();
  return result;
}
static void recycle(State& s,std::vector<uint8_t>&& pixelData){
  std::lock_guard<std::mutex> lock(s.mutex);
  if(pixelData.capacity()>s.recycled.capacity())
    s.recycled=std::move(pixelData);
}
static void validate(Frame const& f,size_t n) {
  assert(f.pixels.size()==n);
  for(size_t i=0;i<n;++i)assert(f.pixels[i]==uint8_t((i+f.id)%251u));
}
int main() {
  constexpr size_t n=256*256*4;
  State s;
  // When a newer frame replaces an unconsumed frame, only the dead frame may
  // be recycled. A consumer-owned frame must remain valid until conversion.
  deliver(s,1,n);
  auto borrowed=receive(s);
  assert(borrowed.has_value());
  deliver(s,2,n);
  deliver(s,3,n); // replace dead 2 with 3, never touch borrower 1
  validate(*borrowed,n);
  auto newest=receive(s);
  assert(newest.has_value()&&newest->id==3);
  validate(*newest,n);
  recycle(s,std::move(newest->pixels));
  // Under stable producer/consumer cadence the allocation count should not grow.
  const auto initial=s.allocations;
  for(uint64_t i=4;i<204;i++){
    deliver(s,i,n);
    auto f=receive(s);
    assert(f.has_value()&&f->id==i);
    validate(*f,n);
    recycle(s,std::move(f->pixels));
  }
  assert(s.reuses>=200);
  assert(s.allocations==initial);
  assert(s.replacements>=1);
  // A read in progress survives another callback and a new delivery.
  deliver(s,204,n);
  auto inFlight=receive(s);
  deliver(s,205,n);
  validate(*inFlight,n);
  auto latest=receive(s);
  validate(*latest,n);
  std::cout<<"HI5STREAM538_REUSABLE_BGRA_OWNERSHIP_PASS"
           <<" reused="<<s.reuses<<" allocations="<<s.allocations
           <<" replaced="<<s.replacements<<std::endl;
}
