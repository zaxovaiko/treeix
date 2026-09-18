// AppKit calls Electron has no API for. Every change is queued on the main
// queue instead of running inside the JavaScript call: presentation and style
// changes resize windows synchronously, and Electron would re-enter JavaScript
// while this native frame is still on the stack.
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#include <node_api.h>

static bool BoolArg(napi_env env, napi_value value) {
  bool result = false;
  napi_get_value_bool(env, value, &result);
  return result;
}

static napi_value Args(napi_env env, napi_callback_info info, size_t expected, napi_value *argv) {
  size_t argc = expected;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < expected) napi_throw_type_error(env, nullptr, "Missing arguments");
  return nullptr;
}

/** setDockHidden(hidden): auto-hides the Dock while this app is frontmost */
static napi_value SetDockHidden(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Args(env, info, 1, argv);
  bool hidden = BoolArg(env, argv[0]);
  dispatch_async(dispatch_get_main_queue(), ^{
    NSApp.presentationOptions = hidden ? NSApplicationPresentationAutoHideDock : NSApplicationPresentationDefault;
  });
  return nullptr;
}

/** setSquareCorners(nativeWindowHandle, square): drops the titled style, which is what rounds the corners */
static napi_value SetSquareCorners(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  Args(env, info, 2, argv);
  void *data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle");
    return nullptr;
  }
  NSView *view = (__bridge NSView *)(*(void **)data);
  NSWindow *window = view.window;
  bool square = BoolArg(env, argv[1]);
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindowStyleMask mask = window.styleMask;
    NSWindowStyleMask next = square ? (mask & ~NSWindowStyleMaskTitled) : (mask | NSWindowStyleMaskTitled);
    if (next != mask) window.styleMask = next;
  });
  return nullptr;
}

// Global hotkey through Carbon, which accepts any physical key (like § on ISO keyboards)
// and needs no Accessibility permission. One hotkey at a time.
static EventHotKeyRef hotKeyRef = nullptr;
static EventHandlerRef hotKeyHandler = nullptr;
static napi_threadsafe_function hotKeyCallback = nullptr;
static const OSType HOTKEY_SIGNATURE = 'trex';

static OSStatus OnHotKey(EventHandlerCallRef next, EventRef event, void *) {
  EventHotKeyID id;
  GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, nullptr, sizeof(id), nullptr, &id);
  // Other hotkeys (Electron's own globalShortcut) are passed along
  if (id.signature != HOTKEY_SIGNATURE) return eventNotHandledErr;
  // Activate while still handling the key press: macOS only lets an app take focus from another
  // app in response to user input, and by the time JavaScript runs that moment has passed.
  // Without this the window appears but stays inactive, so it has no focus and the Dock stays up.
  // Whether Treeix was already in front decides between hiding and showing, so capture it before activating
  bool *wasActive = new bool(NSApp.isActive);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
  // Hand off to the JavaScript event loop instead of calling into V8 from the Carbon handler
  if (!hotKeyCallback || napi_call_threadsafe_function(hotKeyCallback, wasActive, napi_tsfn_nonblocking) != napi_ok) delete wasActive;
  return noErr;
}

static void CallJs(napi_env env, napi_value callback, void *, void *data) {
  bool *wasActive = static_cast<bool *>(data);
  if (env && callback) {
    napi_value undefined, argument;
    napi_get_undefined(env, &undefined);
    napi_get_boolean(env, wasActive && *wasActive, &argument);
    napi_call_function(env, undefined, callback, 1, &argument, nullptr);
  }
  delete wasActive;
}

static void ReleaseHotKey() {
  if (hotKeyRef) UnregisterEventHotKey(hotKeyRef);
  hotKeyRef = nullptr;
  if (hotKeyCallback) napi_release_threadsafe_function(hotKeyCallback, napi_tsfn_release);
  hotKeyCallback = nullptr;
}

/** registerHotkey(keyCode, carbonModifiers, callback(wasActive)): false when another app already owns the combination */
static napi_value RegisterHotkey(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  Args(env, info, 3, argv);
  uint32_t keyCode = 0, modifiers = 0;
  napi_get_value_uint32(env, argv[0], &keyCode);
  napi_get_value_uint32(env, argv[1], &modifiers);
  ReleaseHotKey();

  if (!hotKeyHandler) {
    EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
    InstallApplicationEventHandler(&OnHotKey, 1, &spec, nullptr, &hotKeyHandler);
  }
  napi_value name;
  napi_create_string_utf8(env, "treeix-hotkey", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, argv[2], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &hotKeyCallback);
  // The registration alone must not keep the process alive
  napi_unref_threadsafe_function(env, hotKeyCallback);

  EventHotKeyID id = {HOTKEY_SIGNATURE, 1};
  OSStatus status = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef);
  if (status != noErr) ReleaseHotKey();
  napi_value result;
  napi_get_boolean(env, status == noErr, &result);
  return result;
}

static napi_value UnregisterHotkey(napi_env env, napi_callback_info) {
  ReleaseHotKey();
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"setDockHidden", nullptr, SetDockHidden, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setSquareCorners", nullptr, SetSquareCorners, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"registerHotkey", nullptr, RegisterHotkey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unregisterHotkey", nullptr, UnregisterHotkey, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
