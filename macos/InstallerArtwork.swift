import AppKit

// Build-time artwork and file metadata only. This helper is not distributed.
let stage = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let artwork = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: artwork, withIntermediateDirectories: true)

let ink = NSColor(calibratedRed: 0.10, green: 0.13, blue: 0.19, alpha: 1)
let muted = NSColor(calibratedRed: 0.39, green: 0.43, blue: 0.49, alpha: 1)
let blue = NSColor(calibratedRed: 0.12, green: 0.39, blue: 0.91, alpha: 1)

func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, canvas: CGFloat) -> NSRect {
    NSRect(x: x, y: canvas - y - h, width: w, height: h)
}

func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat,
          _ size: CGFloat, _ weight: NSFont.Weight = .regular, _ color: NSColor = ink,
          canvas: CGFloat = 600, centered: Bool = false) {
    let style = NSMutableParagraphStyle()
    style.alignment = centered ? .center : .left
    (value as NSString).draw(in: rect(x, y, width, size * 2.3, canvas: canvas), withAttributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: style,
    ])
}

func image(_ size: NSSize, draw: () -> Void) -> NSImage {
    let result = NSImage(size: size)
    for scale in [1, 2] {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width) * scale,
            pixelsHigh: Int(size.height) * scale, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.size = size
        NSGraphicsContext.saveGraphicsState()
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.current = context
        draw()
        NSGraphicsContext.restoreGraphicsState()
        result.addRepresentation(bitmap)
    }
    return result
}

let background = image(NSSize(width: 760, height: 600)) {
    NSColor(calibratedRed: 0.965, green: 0.972, blue: 0.985, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: 760, height: 600).fill()
    text("安装 Codex Co²", 60, 42, 640, 29, .semibold)
    text("将左侧应用拖到 Applications，完成后从“应用程序”打开。", 60, 89, 640, 14, .regular, muted)
    let card = NSBezierPath(roundedRect: rect(40, 132, 680, 198, canvas: 600), xRadius: 22, yRadius: 22)
    NSColor.white.setFill(); card.fill()
    NSColor(calibratedWhite: 0.88, alpha: 1).setStroke(); card.lineWidth = 0.7; card.stroke()
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 342, y: 600 - 215)); arrow.line(to: NSPoint(x: 418, y: 600 - 215))
    arrow.move(to: NSPoint(x: 402, y: 600 - 201)); arrow.line(to: NSPoint(x: 418, y: 600 - 215))
    arrow.line(to: NSPoint(x: 402, y: 600 - 229)); arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
    blue.setStroke(); arrow.lineWidth = 3; arrow.stroke()
    text("首次打开被拦截？", 60, 355, 640, 17, .semibold)
    text("先尝试打开应用，再双击下方入口，手动选择“仍要打开”。", 60, 387, 640, 13, .regular, muted)
    text("macOS 15+ · Apple Silicon · 需要已运行的官方 Codex Desktop", 60, 575, 640, 11, .regular, muted)
}
for case let bitmap as NSBitmapImageRep in background.representations {
    let name = bitmap.pixelsWide == 760 ? "background.png" : "background@2x.png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: artwork.appendingPathComponent(name))
}

for (file, label, primary) in [("打开隐私与安全性.inetloc", "打开隐私与安全性", true), ("安装说明.html", "安装说明", false)] {
    let icon = image(NSSize(width: 256, height: 256)) {
        let box = NSBezierPath(roundedRect: NSRect(x: 4, y: 84, width: 248, height: 88), xRadius: 20, yRadius: 20)
        (primary ? blue : NSColor.white).setFill(); box.fill()
        if !primary { NSColor(calibratedWhite: 0.81, alpha: 1).setStroke(); box.lineWidth = 2; box.stroke() }
        text(label, 6, 105, 244, primary ? 24 : 26, .semibold, primary ? .white : ink, canvas: 256, centered: true)
    }
    let fileURL = stage.appendingPathComponent(file)
    guard NSWorkspace.shared.setIcon(icon, forFile: fileURL.path, options: []) else {
        fatalError("Could not set installer shortcut icon: \(file)")
    }
}
