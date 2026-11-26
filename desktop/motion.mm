#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <cmath>
#include <node_api.h>
#include <string>

@interface FormicandMotionView : NSView
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, CALayer *> *items;
@property(nonatomic, strong)
    NSMutableDictionary<NSNumber *, NSArray *> *appearances;
@end

@implementation FormicandMotionView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
- (BOOL)isAccessibilityElement {
  return NO;
}
@end

static NSColor *color(NSNumber *packed) {
  uint32_t rgba = packed.unsignedIntValue;
  return [NSColor colorWithSRGBRed:(rgba >> 24) / 255.0
                             green:((rgba >> 16) & 255) / 255.0
                              blue:((rgba >> 8) & 255) / 255.0
                             alpha:(rgba & 255) / 255.0];
}

static void animate(CALayer *layer, NSString *key, CAAnimation *animation,
                    NSDictionary *item) {
  animation.duration = [item[@"duration"] doubleValue];
  animation.repeatCount = HUGE_VALF;
  animation.beginTime = [layer convertTime:CACurrentMediaTime() fromLayer:nil] -
                        animation.duration * [item[@"phase"] doubleValue];
  [layer addAnimation:animation forKey:key];
}

static void rotate(CALayer *layer, NSDictionary *item) {
  CABasicAnimation *spin =
      [CABasicAnimation animationWithKeyPath:@"transform.rotation.z"];
  spin.fromValue = @0;
  spin.toValue = @(-2 * M_PI);
  spin.timingFunction =
      [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionLinear];
  animate(layer, @"spin", spin, item);
}

static void pulse(CALayer *layer, NSString *key, NSArray *values,
                  NSDictionary *item, NSString *curve) {
  CAKeyframeAnimation *animation =
      [CAKeyframeAnimation animationWithKeyPath:key];
  animation.values = values;
  CAMediaTimingFunction *ease = [CAMediaTimingFunction functionWithName:curve];
  animation.timingFunctions = @[ ease, ease ];
  animate(layer, key, animation, item);
}

static CAShapeLayer *arc(CGRect bounds, CGFloat radius, CGFloat stroke,
                         CGFloat start, CGFloat end, NSColor *ink,
                         CGFloat scale) {
  CAShapeLayer *layer = [CAShapeLayer layer];
  layer.frame = bounds;
  layer.contentsScale = scale;
  layer.fillColor = nil;
  layer.strokeColor = ink.CGColor;
  layer.lineWidth = stroke;
  CGMutablePathRef path = CGPathCreateMutable();
  CGFloat yRadius =
      radius - (CGRectGetWidth(bounds) - CGRectGetHeight(bounds)) / 2;
  CGAffineTransform ellipse = CGAffineTransformMake(
      radius, 0, 0, yRadius, CGRectGetMidX(bounds), CGRectGetMidY(bounds));
  CGPathAddArc(path, &ellipse, 0, 0, 1, start, end, false);
  layer.path = path;
  CGPathRelease(path);
  return layer;
}

static CALayer *drawing(NSDictionary *item, CGFloat scale, NSImage *strip) {
  CGFloat size = [item[@"size"] doubleValue],
          stroke = [item[@"stroke"] doubleValue];
  CALayer *layer = [CALayer layer];
  layer.bounds =
      CGRectMake(0, 0, size, [item[@"height"] ?: item[@"size"] doubleValue]);
  NSString *kind = item[@"kind"];
  NSColor *ink = color(item[@"color"]);
  if ([kind isEqual:@"ring"] || [kind isEqual:@"loader"] ||
      [kind isEqual:@"copied"] || [kind isEqual:@"checked"]) {
    // Chromium transforms the already painted icon, including its antialiased
    // edges.
    layer.shouldRasterize = YES;
    layer.rasterizationScale = scale;
  }
  if ([kind isEqual:@"ring"] || [kind isEqual:@"loader"]) {
    BOOL loader = [kind isEqual:@"loader"];
    CGFloat radius = loader ? size * 9 / 24 : (size - stroke) / 2;
    CGFloat start =
        loader ? M_PI * .4 : ([item[@"top"] boolValue] ? M_PI / 4 : -M_PI / 4);
    CGFloat end = loader ? 2 * M_PI : start + M_PI / 2;
    if (!loader)
      [layer addSublayer:arc(layer.bounds, radius, stroke, end,
                             start + 2 * M_PI, ink, scale)];
    CAShapeLayer *accent = arc(layer.bounds, radius, stroke, start, end,
                               loader ? ink : color(item[@"accent"]), scale);
    if (loader)
      accent.lineCap = kCALineCapRound;
    [layer addSublayer:accent];
    rotate(layer, item);
  } else if ([kind isEqual:@"checked"] || [kind isEqual:@"copied"]) {
    // The shared i-check glyph has a 24-unit viewBox and rounded strokes.
    CAShapeLayer *glyph = [CAShapeLayer layer];
    glyph.frame = layer.bounds;
    glyph.contentsScale = scale;
    CGFloat unit = size / 24;
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathMoveToPoint(path, nil, 20 * unit, 18 * unit);
    CGPathAddLineToPoint(path, nil, 9 * unit, 7 * unit);
    CGPathAddLineToPoint(path, nil, 4 * unit, 12 * unit);
    glyph.path = path;
    CGPathRelease(path);
    glyph.fillColor = nil;
    glyph.strokeColor = ink.CGColor;
    glyph.lineWidth = stroke;
    glyph.lineCap = kCALineCapRound;
    glyph.lineJoin = kCALineJoinRound;
    [layer addSublayer:glyph];
    BOOL copy = [kind isEqual:@"copied"];
    CAKeyframeAnimation *pop =
        [CAKeyframeAnimation animationWithKeyPath:@"transform.scale"];
    pop.keyTimes = @[ @0, @.6, @1 ];
    pop.values = @[ copy ? @.6 : @.5, copy ? @1.12 : @1.15, @1 ];
    CAKeyframeAnimation *fade =
        [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
    fade.keyTimes = pop.keyTimes;
    fade.values = @[ copy ? @.4 : @.3, @1, @1 ];
    CAAnimationGroup *group = [CAAnimationGroup animation];
    group.duration = pop.duration = fade.duration =
        [item[@"duration"] doubleValue];
    group.animations = @[ pop, fade ];
    group.timingFunction =
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    group.beginTime = [layer convertTime:CACurrentMediaTime() fromLayer:nil] -
                      group.duration * [item[@"phase"] doubleValue];
    [layer addAnimation:group forKey:@"check"];
  } else if ([kind isEqual:@"ant"]) {
    // The stationary feelers stay in the DOM. Move the alpha mask by whole
    // frames.
    layer.backgroundColor = ink.CGColor;
    CALayer *mask = [CALayer layer];
    mask.frame = layer.bounds;
    mask.contents =
        (__bridge id)[strip CGImageForProposedRect:nil context:nil hints:nil];
    mask.contentsRect = CGRectMake(0, 0, 1.0 / 24, 1);
    layer.mask = mask;
    CAKeyframeAnimation *frames =
        [CAKeyframeAnimation animationWithKeyPath:@"contentsRect"];
    NSMutableArray *values = [NSMutableArray array];
    NSMutableArray *times = [NSMutableArray array];
    for (int i = 0; i <= 24; i++) {
      [values addObject:[NSValue valueWithRect:NSMakeRect((i % 24) / 24.0, 0,
                                                          1.0 / 24, 1)]];
      [times addObject:@(i / 24.0)];
    }
    frames.values = values;
    frames.keyTimes = times;
    frames.calculationMode = kCAAnimationDiscrete;
    animate(mask, @"frames", frames, item);
  } else if ([kind isEqual:@"head"]) {
    layer.backgroundColor = ink.CGColor;
    layer.cornerRadius = size / 2;
    pulse(layer, @"transform.scale", @[ @.82, @1.12, @.82 ], item,
          kCAMediaTimingFunctionEaseInEaseOut);
    pulse(layer, @"opacity", @[ @.55, @1, @.55 ], item,
          kCAMediaTimingFunctionEaseInEaseOut);
  }
  return layer;
}

// A drawing kept while the page played it starts again from the page's phase.
static void retime(CALayer *layer, double phase) {
  NSMutableArray *layers = [NSMutableArray arrayWithObject:layer];
  [layers addObjectsFromArray:layer.sublayers ?: @[]];
  if (layer.mask)
    [layers addObject:layer.mask];
  for (CALayer *part in layers)
    for (NSString *key in part.animationKeys ?: @[]) {
      CAAnimation *animation = [[part animationForKey:key] copy];
      animation.beginTime = [part convertTime:CACurrentMediaTime() fromLayer:nil] -
                            animation.duration * phase;
      [part addAnimation:animation forKey:key];
    }
}

static NSString *stringArg(napi_env env, napi_value value, size_t limit) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok ||
      size > limit)
    return nil;
  std::string buffer(size + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(),
                                 &size) != napi_ok)
    return nil;
  return [[NSString alloc] initWithBytes:buffer.data()
                                  length:size
                                encoding:NSUTF8StringEncoding];
}

static napi_value update(napi_env env, napi_callback_info info) {
  size_t argc = 3, length = 0;
  napi_value args[3], result;
  void *bytes = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3 || !NSThread.isMainThread ||
      napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok ||
      length != sizeof(void *)) {
    napi_throw_type_error(
        env, nullptr, "Expected an Electron content view on the main thread");
    return nullptr;
  }
  NSView *root = (__bridge NSView *)(*(void **)bytes);
  NSData *json =
      [stringArg(env, args[1], 65536) dataUsingEncoding:NSUTF8StringEncoding];
  NSArray *scene = json ? [NSJSONSerialization JSONObjectWithData:json
                                                          options:0
                                                            error:nil]
                        : nil;
  static NSImage *strip;
  if (!strip)
    strip =
        [[NSImage alloc] initWithContentsOfFile:stringArg(env, args[2], 16384)];
  bool ok = root.window && [scene isKindOfClass:NSArray.class] && strip;
  if (ok) {
    FormicandMotionView *view = nil;
    for (NSView *child in root.subviews)
      if ([child isKindOfClass:FormicandMotionView.class]) {
        view = (FormicandMotionView *)child;
        break;
      }
    // An empty scene hides the layers instead of dropping them: scrolling hands
    // drawings to the page and back many times, and the same drawing comes back
    // with its layer and phase. Drawings left out of the next scene go then.
    BOOL resumed = view.hidden && scene.count;
    view.hidden = !scene.count;
    if (scene.count) {
      if (!view) {
        view = [[FormicandMotionView alloc] initWithFrame:root.bounds];
        view.wantsLayer = YES;
        view.items = [NSMutableDictionary dictionary];
        view.appearances = [NSMutableDictionary dictionary];
        [root addSubview:view positioned:NSWindowAbove relativeTo:nil];
      }
      // Pin the layers to the top edge, as the page lays them out, so a window
      // being resized does not drag them with its bottom edge before the page
      // reports the new positions.
      view.autoresizingMask = NSViewWidthSizable |
                              (root.isFlipped ? NSViewMaxYMargin : NSViewMinYMargin);
      if (!NSEqualRects(view.frame, root.bounds))
        view.frame = root.bounds;
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      NSMutableSet *stale = [NSMutableSet setWithArray:view.items.allKeys];
      CGFloat scale = root.window.backingScaleFactor;
      for (NSDictionary *item in scene) {
        NSNumber *key = item[@"id"];
        [stale removeObject:key];
        NSArray *appearance = @[
          item[@"kind"], item[@"size"], item[@"stroke"], item[@"duration"],
          item[@"height"] ?: item[@"size"], item[@"color"], item[@"accent"],
          item[@"top"], @(scale)
        ];
        CALayer *layer = view.items[key];
        if (![appearance isEqual:view.appearances[key]]) {
          [layer removeFromSuperlayer];
          layer = drawing(item, scale, strip);
          view.appearances[key] = appearance;
          view.items[key] = layer;
          [view.layer addSublayer:layer];
        } else if (resumed)
          retime(layer, [item[@"phase"] doubleValue]);
        CGFloat radius = [item[@"size"] doubleValue] / 2;
        layer.position =
            CGPointMake([item[@"x"] doubleValue] + radius,
                        NSHeight(view.bounds) - [item[@"y"] doubleValue] -
                            CGRectGetHeight(layer.bounds) / 2);
      }
      for (NSNumber *key in stale) {
        [view.items[key] removeFromSuperlayer];
        [view.items removeObjectForKey:key];
        [view.appearances removeObjectForKey:key];
      }
      [CATransaction commit];
    }
  }
  napi_get_boolean(env, ok, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "update", NAPI_AUTO_LENGTH, update, nullptr, &fn);
  napi_set_named_property(env, exports, "update", fn);
  return exports;
}
