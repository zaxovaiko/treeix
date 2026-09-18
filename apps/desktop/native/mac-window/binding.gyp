{
  "targets": [
    {
      "target_name": "mac_window",
      "sources": ["mac_window.mm"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_LDFLAGS": ["-framework Cocoa", "-framework Carbon"]
          }
        }]
      ]
    }
  ]
}
