import UIKit
import UniformTypeIdentifiers

/// The app in other apps' share sheets. An extension cannot reach the app's
/// web view, so it leaves what was shared in the app group's container (a
/// folder with manifest.json and the files) and opens the app, whose
/// ShareTargetPlugin hands it to the web client. Up to ten files of 20 MB, as
/// on Android.
class ShareViewController: UIViewController {
    private static let maxFiles = 10
    private static let maxBytes = 20 * 1024 * 1024

    private let label = UILabel()
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.text = NSLocalizedString("Preparing…", comment: "Shown while the shared items are copied")
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .body)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { await collect() }
    }

    private func collect() async {
        guard let folder = newFolder() else {
            finish(message: NSLocalizedString("Sharing is not set up in this build of the app.", comment: "No app group"))
            return
        }
        var texts: [String] = []
        var files: [[String: Any]] = []
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        for item in items {
            if let content = item.attributedContentText?.string, !content.isEmpty { texts.append(content) }
            for provider in item.attachments ?? [] {
                if files.count < Self.maxFiles, let file = await copyFile(provider, into: folder, index: files.count) {
                    files.append(file)
                } else if let url = await loadURL(provider) {
                    texts.append(url.absoluteString)
                } else if let text = await loadText(provider) {
                    texts.append(text)
                }
            }
        }
        // The same link often comes as both text and URL.
        var seen = Set<String>()
        let text = texts.filter { seen.insert($0).inserted }.joined(separator: "\n")
        guard !text.isEmpty || !files.isEmpty else {
            try? FileManager.default.removeItem(at: folder)
            finish(message: NSLocalizedString("Nothing here can be sent.", comment: "Nothing usable was shared"))
            return
        }
        let manifest: [String: Any] = ["text": text, "files": files]
        guard let data = try? JSONSerialization.data(withJSONObject: manifest),
              (try? data.write(to: folder.appendingPathComponent("manifest.json"))) != nil else {
            finish(message: NSLocalizedString("Could not save what was shared.", comment: "Write failed"))
            return
        }
        if await openApp() {
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            finish(message: NSLocalizedString("Saved. Open the app to choose where to send it.", comment: "The app could not be opened"))
        }
    }

    private func newFolder() -> URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ShareAppGroup") as? String, !group.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let folder = container.appendingPathComponent("shares", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            return folder
        } catch {
            return nil
        }
    }

    /// Files, pictures and videos: copied into the folder.
    private func copyFile(_ provider: NSItemProvider, into folder: URL, index: Int) async -> [String: Any]? {
        let textual: [UTType] = [.url, .plainText, .text]
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        guard let type = types.first(where: { type in type.conforms(to: .fileURL) || !textual.contains(where: { type.conforms(to: $0) }) }) else { return nil }
        let limit = Self.maxBytes
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            // The file exists only until this handler returns: copy it here.
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url,
                      let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= limit else {
                    continuation.resume(returning: nil)
                    return
                }
                let ext = url.pathExtension
                let name = suggested.map { ext.isEmpty || $0.hasSuffix(".\(ext)") ? $0 : "\($0).\(ext)" } ?? url.lastPathComponent
                let path = "\(index)-\(url.lastPathComponent)"
                do {
                    try FileManager.default.copyItem(at: url, to: folder.appendingPathComponent(path))
                    let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? type.preferredMIMEType ?? "application/octet-stream"
                    continuation.resume(returning: ["name": name, "type": mime, "path": path])
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func loadURL(_ provider: NSItemProvider) async -> URL? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
                continuation.resume(returning: (item as? URL).flatMap { $0.isFileURL ? nil : $0 })
            }
        }
    }

    private func loadText(_ provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
                continuation.resume(returning: item as? String)
            }
        }
    }

    /// Opens the app at `<scheme>://share`. Extensions have no UIApplication of
    /// their own; the app's is reached through the responder chain.
    @MainActor
    private func openApp() async -> Bool {
        guard let scheme = Self.appScheme, let url = URL(string: "\(scheme)://share") else { return false }
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                return await withCheckedContinuation { continuation in
                    application.open(url, options: [:]) { opened in continuation.resume(returning: opened) }
                }
            }
            responder = current.next
        }
        return false
    }

    /// The app's URL scheme, from the Info.plist of the app this extension is inside.
    private static var appScheme: String? {
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        let types = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        return (types?.first?["CFBundleURLSchemes"] as? [String])?.first
    }

    @MainActor
    private func finish(message: String) {
        label.text = message
        let done = UIButton(type: .system)
        done.setTitle(NSLocalizedString("Done", comment: "Close the share sheet"), for: .normal)
        done.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        done.translatesAutoresizingMaskIntoConstraints = false
        done.addAction(UIAction { [weak self] _ in self?.extensionContext?.completeRequest(returningItems: nil) }, for: .touchUpInside)
        view.addSubview(done)
        NSLayoutConstraint.activate([
            done.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            done.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 16),
        ])
    }
}
