#if os(iOS)
  import SwiftUI
  import UIKit
  import VisionKit

  /// Full-screen camera that reads the pairing QR code (VisionKit's DataScannerViewController).
  struct QRScannerSheet: View {
    var onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool {
      DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
      ZStack(alignment: .top) {
        QRScanner(onCode: onCode)
          .ignoresSafeArea()
        HStack {
          Text("Scan the QR code on your computer")
            .font(.headline)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .glassEffect()
          Spacer()
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.headline)
              .frame(width: 44, height: 44)
          }
          .buttonStyle(.graphite)
          .accessibilityLabel("Close")
        }
        .padding()
      }
    }
  }

  struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
      let vc = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
      vc.delegate = context.coordinator
      try? vc.startScanning()
      return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
      let onCode: (String) -> Void
      private var done = false
      init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

      func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        guard !done else { return }
        for item in addedItems {
          if case .barcode(let b) = item, let s = b.payloadStringValue {
            done = true
            dataScanner.stopScanning()
            onCode(s)
            return
          }
        }
      }
    }
  }
#endif
