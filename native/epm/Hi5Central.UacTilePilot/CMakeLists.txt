cmake_minimum_required(VERSION 3.20)
project(Hi5CentralUacTilePilot LANGUAGES CXX)

if (NOT WIN32)
  message(FATAL_ERROR "Windows-only Credential UI proof of concept")
endif()

add_library(Hi5CentralUacTilePilot SHARED UacTilePilot.cpp)
target_compile_features(Hi5CentralUacTilePilot PRIVATE cxx_std_17)
target_compile_definitions(Hi5CentralUacTilePilot PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
target_link_libraries(Hi5CentralUacTilePilot PRIVATE ole32 shlwapi)
set_target_properties(Hi5CentralUacTilePilot PROPERTIES
  OUTPUT_NAME "Hi5CentralUacTilePilot"
  WINDOWS_EXPORT_ALL_SYMBOLS OFF
)

add_executable(Hi5CentralUacTileTest UacTileTest.cpp)
target_compile_features(Hi5CentralUacTileTest PRIVATE cxx_std_17)
target_compile_definitions(Hi5CentralUacTileTest PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
target_link_libraries(Hi5CentralUacTileTest PRIVATE ole32)
enable_testing()
add_test(NAME CredentialUiOnlyAndNoAuthentication
  COMMAND Hi5CentralUacTileTest "$<TARGET_FILE:Hi5CentralUacTilePilot>")
