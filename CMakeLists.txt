cmake_minimum_required(VERSION 3.18)
project(SiegeSeal
  VERSION 1.0.0
  DESCRIPTION "Non-repudiable messaging: Ed25519-signed envelopes, receipts, treaties and equivocation proofs"
  HOMEPAGE_URL "https://github.com/"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

include(GNUInstallDirs)
include(CheckCXXCompilerFlag)
include(CheckPIESupported)

# ---- options ------------------------------------------------------------------
option(SIEGESEAL_HARDEN   "Compile and link with security hardening flags" ON)
option(SIEGESEAL_PORTABLE "Link OpenSSL and the C++ runtime statically, so the binaries run without them installed" OFF)
option(SIEGESEAL_FULLY_STATIC "Link everything, libc included, into self-contained executables (use with a musl toolchain)" OFF)
option(SIEGESEAL_RELEASE_LAYOUT "Also put README/LICENSE at the top of the install tree (for release tarballs)" OFF)
option(SIEGESEAL_BUILD_TESTS "Build and register tests" ON)

# ---- dependencies ---------------------------------------------------------------
if(SIEGESEAL_PORTABLE OR SIEGESEAL_FULLY_STATIC)
  set(OPENSSL_USE_STATIC_LIBS TRUE)
endif()
find_package(OpenSSL 3.0 REQUIRED)
set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

# ---- toolchain flags --------------------------------------------------------------
check_pie_supported()
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT MSVC)
  # Keep absolute build paths out of the binaries (and out of their debug info).
  add_compile_options(
    "-ffile-prefix-map=${CMAKE_SOURCE_DIR}=."
    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=build")
  # Let the linker drop code nothing calls.
  if(NOT APPLE)
    add_compile_options(-ffunction-sections -fdata-sections)
    add_link_options("LINKER:--gc-sections")
  endif()
endif()

if(SIEGESEAL_HARDEN AND NOT MSVC)
  add_compile_options(
    -fstack-protector-strong
    -D_GLIBCXX_ASSERTIONS
    "$<$<NOT:$<CONFIG:Debug>>:-U_FORTIFY_SOURCE;-D_FORTIFY_SOURCE=3>")
  foreach(flag -fstack-clash-protection -fcf-protection=full)
    string(MAKE_C_IDENTIFIER "HAS${flag}" var)
    check_cxx_compiler_flag(${flag} ${var})
    if(${var})
      add_compile_options(${flag})
    endif()
  endforeach()
  if(NOT APPLE)
    add_link_options("LINKER:-z,relro" "LINKER:-z,now" "LINKER:-z,noexecstack")
    if(NOT SIEGESEAL_FULLY_STATIC)
      add_link_options("LINKER:--as-needed") # nothing to drop in a fully static link
    endif()
  endif()
endif()

if(SIEGESEAL_FULLY_STATIC AND NOT MSVC AND NOT APPLE)
  # A static PIE keeps address-space randomisation without needing a dynamic loader.
  include(CheckLinkerFlag)
  check_linker_flag(CXX -static-pie HAS_STATIC_PIE)
  if(HAS_STATIC_PIE)
    add_link_options(-static-pie)
  else()
    add_link_options(-static)
  endif()
elseif(SIEGESEAL_PORTABLE AND NOT MSVC AND NOT APPLE)
  add_link_options(-static-libstdc++ -static-libgcc)
endif()

# ---- version header ---------------------------------------------------------------
configure_file(include/siegeseal/version.hpp.in
  "${CMAKE_BINARY_DIR}/generated/siegeseal/version.hpp" @ONLY)

# ---- library ------------------------------------------------------------------------
add_library(siegeseal
  src/crypto.cpp
  src/protocol.cpp
  src/party.cpp)
add_library(SiegeSeal::siegeseal ALIAS siegeseal)
target_include_directories(siegeseal PUBLIC
  "$<BUILD_INTERFACE:${CMAKE_SOURCE_DIR}/include>"
  "$<BUILD_INTERFACE:${CMAKE_BINARY_DIR}/generated>"
  "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
target_link_libraries(siegeseal PUBLIC OpenSSL::Crypto Threads::Threads ${CMAKE_DL_LIBS})
target_compile_features(siegeseal PUBLIC cxx_std_17)
if(MSVC)
  target_compile_options(siegeseal PRIVATE /W4)
else()
  target_compile_options(siegeseal PRIVATE -Wall -Wextra -Wpedantic)
endif()

# ---- programs -----------------------------------------------------------------------
add_executable(siege_sim apps/siege_sim.cpp)
target_link_libraries(siege_sim PRIVATE siegeseal)

add_executable(siegeseal_cli apps/siegeseal_cli.cpp)
set_target_properties(siegeseal_cli PROPERTIES OUTPUT_NAME siegeseal)
target_link_libraries(siegeseal_cli PRIVATE siegeseal)

add_executable(siegeseal_bench apps/siegeseal_bench.cpp)
target_link_libraries(siegeseal_bench PRIVATE siegeseal)

# ---- tests --------------------------------------------------------------------------
if(SIEGESEAL_BUILD_TESTS)
  enable_testing()
  add_executable(siegeseal_tests tests/test_main.cpp)
  target_link_libraries(siegeseal_tests PRIVATE siegeseal)
  add_test(NAME unit COMMAND siegeseal_tests)
  add_test(NAME cli_roundtrip COMMAND sh "${CMAKE_SOURCE_DIR}/tests/cli_roundtrip.sh" "$<TARGET_FILE:siegeseal_cli>")
  add_test(NAME simulation COMMAND siege_sim --no-color)
  set_tests_properties(simulation PROPERTIES PASS_REGULAR_EXPRESSION "EQUIVOCATION by Cyrene")
  add_test(NAME bench_smoke COMMAND siegeseal_bench 500)
  find_program(NODE_EXECUTABLE node)
  if(NODE_EXECUTABLE)
    add_test(NAME web_protocol COMMAND ${NODE_EXECUTABLE} "${CMAKE_SOURCE_DIR}/tests/web/protocol.test.mjs" "$<TARGET_FILE:siegeseal_cli>")
    add_test(NAME web_store COMMAND ${NODE_EXECUTABLE} "${CMAKE_SOURCE_DIR}/tests/web/store.test.mjs")
  endif()
endif()

# ---- install --------------------------------------------------------------------------
install(TARGETS siegeseal_cli siege_sim siegeseal_bench RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
# The library, headers and CMake package are only useful when built with the
# platform's own C++ toolchain; a fully static (musl) build ships tools only.
if(NOT SIEGESEAL_FULLY_STATIC)
  install(TARGETS siegeseal EXPORT SiegeSealTargets
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR})
  install(DIRECTORY include/siegeseal DESTINATION ${CMAKE_INSTALL_INCLUDEDIR} FILES_MATCHING PATTERN "*.hpp")
  install(FILES "${CMAKE_BINARY_DIR}/generated/siegeseal/version.hpp" DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/siegeseal)

  include(CMakePackageConfigHelpers)
  set(SIEGESEAL_CMAKE_DIR ${CMAKE_INSTALL_LIBDIR}/cmake/SiegeSeal)
  install(EXPORT SiegeSealTargets NAMESPACE SiegeSeal:: DESTINATION ${SIEGESEAL_CMAKE_DIR})
  configure_package_config_file(cmake/SiegeSealConfig.cmake.in
    "${CMAKE_BINARY_DIR}/SiegeSealConfig.cmake" INSTALL_DESTINATION ${SIEGESEAL_CMAKE_DIR})
  write_basic_package_version_file("${CMAKE_BINARY_DIR}/SiegeSealConfigVersion.cmake" COMPATIBILITY SameMajorVersion)
  install(FILES "${CMAKE_BINARY_DIR}/SiegeSealConfig.cmake" "${CMAKE_BINARY_DIR}/SiegeSealConfigVersion.cmake"
    DESTINATION ${SIEGESEAL_CMAKE_DIR})
endif()

install(FILES man/siegeseal.1 man/siege_sim.1 DESTINATION ${CMAKE_INSTALL_MANDIR}/man1)
install(FILES README.md TEACHING.md CHANGELOG.md LICENSE THIRD-PARTY-NOTICES.md DESTINATION ${CMAKE_INSTALL_DOCDIR})
install(DIRECTORY licenses/ DESTINATION ${CMAKE_INSTALL_DOCDIR}/licenses)
install(DIRECTORY docs/ DESTINATION ${CMAKE_INSTALL_DATADIR}/siegeseal/web)
if(SIEGESEAL_RELEASE_LAYOUT)
  install(FILES README.md LICENSE CHANGELOG.md THIRD-PARTY-NOTICES.md DESTINATION .)
endif()

# ---- packaging ------------------------------------------------------------------------
string(TOLOWER "${CMAKE_SYSTEM_NAME}" SIEGESEAL_OS)
set(SIEGESEAL_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
if(SIEGESEAL_FULLY_STATIC)
  set(SIEGESEAL_ARCH "${SIEGESEAL_ARCH}-static")
endif()
set(CPACK_PACKAGE_NAME "siegeseal")
set(CPACK_PACKAGE_VENDOR "SiegeSeal")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "${PROJECT_DESCRIPTION}")
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_SOURCE_DIR}/LICENSE")
set(CPACK_GENERATOR "TGZ")
set(CPACK_PACKAGE_FILE_NAME "siegeseal-${PROJECT_VERSION}-${SIEGESEAL_OS}-${SIEGESEAL_ARCH}")
set(CPACK_STRIP_FILES ON)
set(CPACK_PACKAGE_CHECKSUM SHA256)
set(CPACK_SOURCE_GENERATOR "TGZ")
set(CPACK_SOURCE_PACKAGE_FILE_NAME "siegeseal-${PROJECT_VERSION}-source")
set(CPACK_SOURCE_IGNORE_FILES "/build[^/]*/;/build[^/]*\\\\.log$;/\\\\.git/;/dist/;/node_modules/;\\\\.seal$;\\\\.swp$")
include(CPack)
