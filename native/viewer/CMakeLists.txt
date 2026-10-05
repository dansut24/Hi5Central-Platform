cmake_minimum_required(VERSION 3.22)

project(hi5central_viewer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(HI5CENTRAL_VIEWER_VERSION "0.2.0" CACHE STRING "Hi5Central Viewer version")

if (APPLE)
    enable_language(OBJCXX)
endif()

set(HI5_VIEWER_COMMON_SOURCES
    src/main.cpp
    src/core/logger.cpp
    src/core/deep_link.cpp
)

if (UNIX AND NOT APPLE)
    find_package(Qt6 REQUIRED COMPONENTS Widgets WebEngineWidgets)
    add_executable(hi5tech-viewer
        ${HI5_VIEWER_COMMON_SOURCES}
        src/app/viewer_app_linux_qt.cpp
    )
else()
    include(FetchContent)
    FetchContent_Declare(
        webview
        GIT_REPOSITORY https://github.com/webview/webview.git
        GIT_TAG 0.12.0
    )

    set(WEBVIEW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(WEBVIEW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(WEBVIEW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
    set(WEBVIEW_BUILD_AMALGAMATION OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(webview)

    add_executable(hi5tech-viewer
        ${HI5_VIEWER_COMMON_SOURCES}
        src/app/viewer_app.cpp
    )
    target_link_libraries(hi5tech-viewer PRIVATE webview::core)
endif()

target_include_directories(hi5tech-viewer PRIVATE
    src
)

target_compile_definitions(hi5tech-viewer PRIVATE
    HI5CENTRAL_VIEWER_VERSION="${HI5CENTRAL_VIEWER_VERSION}"
)

if (WIN32)
    target_compile_definitions(hi5tech-viewer PRIVATE
        WIN32_LEAN_AND_MEAN
        NOMINMAX
        _CRT_SECURE_NO_WARNINGS
    )
elseif (APPLE)
    target_compile_definitions(hi5tech-viewer PRIVATE HI5_VIEWER_MACOS=1)
else()
    target_link_libraries(hi5tech-viewer PRIVATE
        Qt6::Widgets
        Qt6::WebEngineWidgets
    )
    target_compile_definitions(hi5tech-viewer PRIVATE HI5_VIEWER_LINUX=1 HI5_VIEWER_QT_WEBENGINE=1)
endif()

add_custom_command(TARGET hi5tech-viewer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:hi5tech-viewer>/web"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/web/index.html"
        "$<TARGET_FILE_DIR:hi5tech-viewer>/web/index.html"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/web/renderer.js"
        "$<TARGET_FILE_DIR:hi5tech-viewer>/web/renderer.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_SOURCE_DIR}/web/file_browser.html"
        "$<TARGET_FILE_DIR:hi5tech-viewer>/web/file_browser.html"
)

if (APPLE)
    add_executable(hi5central-viewer-launcher MACOSX_BUNDLE
        installer/macos/launcher.mm
    )
    target_link_libraries(hi5central-viewer-launcher PRIVATE
        "-framework Cocoa"
        "-framework CoreServices"
    )
    add_dependencies(hi5central-viewer-launcher hi5tech-viewer)

    set_target_properties(hi5tech-viewer PROPERTIES
        OUTPUT_NAME "Hi5CentralViewerCore"
    )

    set_target_properties(hi5central-viewer-launcher PROPERTIES
        OUTPUT_NAME "Hi5CentralViewer"
        MACOSX_BUNDLE TRUE
        MACOSX_BUNDLE_BUNDLE_NAME "Hi5Central Viewer"
        MACOSX_BUNDLE_GUI_IDENTIFIER "com.hi5central.viewer"
        MACOSX_BUNDLE_BUNDLE_VERSION "${HI5CENTRAL_VIEWER_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${HI5CENTRAL_VIEWER_VERSION}"
        MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/installer/macos/Info.plist.in"
    )

    add_custom_command(TARGET hi5central-viewer-launcher POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:hi5tech-viewer>"
            "$<TARGET_BUNDLE_DIR:hi5central-viewer-launcher>/Contents/MacOS/Hi5CentralViewerCore"
        COMMAND ${CMAKE_COMMAND} -E make_directory
            "$<TARGET_BUNDLE_DIR:hi5central-viewer-launcher>/Contents/Resources/web"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_SOURCE_DIR}/web/index.html"
            "$<TARGET_BUNDLE_DIR:hi5central-viewer-launcher>/Contents/Resources/web/index.html"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_SOURCE_DIR}/web/renderer.js"
            "$<TARGET_BUNDLE_DIR:hi5central-viewer-launcher>/Contents/Resources/web/renderer.js"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_SOURCE_DIR}/web/file_browser.html"
            "$<TARGET_BUNDLE_DIR:hi5central-viewer-launcher>/Contents/Resources/web/file_browser.html"
    )
else()
    set_target_properties(hi5tech-viewer PROPERTIES
        OUTPUT_NAME "Hi5CentralViewer"
    )
endif()
