import Capacitor
import Foundation
import UIKit

/// Text and files shared to the app from another app's share sheet (iOS).
///
/// The share extension (ShareExtension/ShareViewController.swift) cannot hand
/// anything to the app directly; it leaves what was shared in the app group's
/// container, one folder per share with a manifest.json, and opens the app.
/// The web client asks for it with take() when a server's page starts, and
/// hears "shareReceived" while one is open, as on Android
/// (ShareTargetPlugin.java); it then lets the person choose where to send it.
@objc(ShareTargetPlugin)
public class ShareTargetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareTargetPlugin"
    public let jsName = "ShareTarget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc func take(_ call: CAPPluginCall) {
        call.resolve(ShareInbox.take() ?? [:])
    }

    /// Back from the share sheet with a server's page open: hand it over now.
    /// With no listener (the server list is showing) it waits for take().
    @objc private func becameActive() {
        guard hasListeners("shareReceived"), let shared = ShareInbox.take() else { return }
        notifyListeners("shareReceived", data: shared)
    }
}

/// The app group folder the share extension writes to.
enum ShareInbox {
    static var folder: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ShareAppGroup") as? String, !group.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return container.appendingPathComponent("shares", isDirectory: true)
    }

    /// The oldest waiting share, as the web client takes it, removed from the folder.
    static func take() -> [String: Any]? {
        guard let folder = folder,
              let entries = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey]) else { return nil }
        let sorted = entries.sorted { created($0) < created($1) }
        for entry in sorted {
            defer { try? FileManager.default.removeItem(at: entry) }
            guard let data = try? Data(contentsOf: entry.appendingPathComponent("manifest.json")),
                  let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            var shared: [String: Any] = [:]
            if let text = manifest["text"] as? String, !text.isEmpty { shared["text"] = text }
            var files: [[String: Any]] = []
            for file in manifest["files"] as? [[String: Any]] ?? [] {
                guard let path = file["path"] as? String,
                      let bytes = try? Data(contentsOf: entry.appendingPathComponent(path)) else { continue }
                files.append([
                    "name": file["name"] as? String ?? "shared",
                    "type": file["type"] as? String ?? "application/octet-stream",
                    "data": bytes.base64EncodedString(),
                ])
            }
            if !files.isEmpty { shared["files"] = files }
            if !shared.isEmpty { return shared }
        }
        return nil
    }

    private static func created(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
    }
}
