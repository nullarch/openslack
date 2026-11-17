import Capacitor
import UIKit

/// The app's web view. Registers the plugins that live in this app rather
/// than in a package (the share sheet's ShareTargetPlugin).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareTargetPlugin())
    }
}
