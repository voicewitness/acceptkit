import Vision
import AppKit
// 四遍识别、全部打印：原图 zh-Hans+en accurate（认中文）、原图 en accurate、原图 / 2 倍放大 en fast（等宽代码 / JSON 行）。
// 例：「"scene" : "some_switch_name"」与下一行「"stage" : "boot"」在原图上可能被认成乱码 / 两行粘连，
// 放大后才认得出。调用方只做「读值是否出现在 OCR 全文里」的包含判断，多几遍只增召回、不会把屏外的值变成屏内。
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let img = NSImage(contentsOf: url) else { exit(2) }
var rect = NSRect(origin: .zero, size: img.size)
guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { exit(3) }
func scaled(_ src: CGImage, _ k: Int) -> CGImage? {
    let w = src.width * k, h = src.height * k
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}
var passes: [(CGImage, [String], VNRequestTextRecognitionLevel)] = [(cg, ["zh-Hans", "en-US"], .accurate), (cg, ["en-US"], .accurate), (cg, ["en-US"], .fast)]
// .fast 对等宽 JSON 反而准：.accurate 的版面分析会把「"scene" : "…"」与下一行「"stage" : "boot"」认成一行乱码，
// .fast 逐词出（键名与值都能认对；分条、放大 + accurate 都救不回来）
if let big = scaled(cg, 2) { passes.append((big, ["en-US"], .fast)) }
for (im, langs, level) in passes {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = level
    req.recognitionLanguages = langs
    req.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: im, options: [:]).perform([req])
    for o in (req.results ?? []) { if let t = o.topCandidates(1).first?.string { print(t) } }
}
