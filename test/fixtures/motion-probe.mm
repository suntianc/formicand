// Test-only inspection of the actual AppKit hierarchy and its presentation
// tree.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <cmath>
#include <node_api.h>

static napi_value inspect(napi_env env, napi_callback_info info) {
  size_t argc = 1, size = 0;
  napi_value handle, result;
  void *bytes = nullptr;
  napi_get_cb_info(env, info, &argc, &handle, nullptr, nullptr);
  if (argc != 1 ||
      napi_get_buffer_info(env, handle, &bytes, &size) != napi_ok ||
      size != sizeof(void *))
    return nullptr;
  NSView *root = (__bridge NSView *)(*(void **)bytes);
  NSMutableArray *layers = [NSMutableArray array];
  for (NSView *view in root.subviews) {
    // A hidden view keeps its layers for the next scene but shows nothing.
    if (![NSStringFromClass(view.class) isEqual:@"FormicandMotionView"] ||
        view.hidden)
      continue;
    for (CALayer *layer in view.layer.sublayers) {
      CALayer *shown = layer.presentationLayer;
      if (!shown)
        continue;
      CATransform3D matrix = shown.transform;
      NSRect pos = [root convertRect:layer.frame fromView:view];
      [layers addObject:@{
        @"x" : @(NSMinX(pos)),
        @"y" :
            @(root.flipped ? NSMinY(pos) : NSHeight(root.bounds) - NSMaxY(pos)),
        @"size" : @(NSWidth(pos)),
        @"angle" : @(atan2(matrix.m12, matrix.m11)),
        @"sprite" : @([layer.mask animationForKey:@"frames"] != nil),
        @"spin" : @([layer animationForKey:@"spin"] != nil),
        @"frame" : @(shown.mask.contentsRect.origin.x),
        @"hasImage" : @(layer.mask.contents != nil)
      }];
    }
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:layers
                                                 options:0
                                                   error:nil];
  napi_create_string_utf8(env, (const char *)data.bytes, data.length, &result);
  return result;
}
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, inspect, nullptr, &fn);
  return fn;
}
