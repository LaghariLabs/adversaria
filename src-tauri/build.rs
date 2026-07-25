fn main() {
    // On macOS, ScreenCaptureKit (via the apple-cf / apple-metal crates) links
    // against the Swift runtime, so the binary references
    // `@rpath/libswift_Concurrency.dylib` (and friends). Without an rpath the app
    // links fine but crashes at launch with a dyld "Library not loaded" error.
    // `/usr/lib/swift` is the OS Swift runtime location (resolved from the dyld
    // shared cache); adding it as an rpath lets the app find the runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build();
}
