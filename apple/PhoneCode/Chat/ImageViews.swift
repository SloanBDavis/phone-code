import PhoneCodeCore
import SwiftUI

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// Thumbnails of a message's images; tap one to open the viewer.
struct ImageStrip: View {
  let sessionId: String
  let images: [ImageRef]
  @State private var viewing: ImageRef?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(images) { ref in
          Button {
            viewing = ref
          } label: {
            AuthImage(sessionId: sessionId, ref: ref, width: 320)
              .frame(width: 120, height: 120)
              .clipShape(.rect(cornerRadius: 12))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(ref.name ?? "Image")
          .accessibilityIdentifier("chat-image")
        }
      }
    }
    #if os(iOS)
      .fullScreenCover(item: $viewing) { ref in
        ImageViewer(sessionId: sessionId, ref: ref)
      }
    #else
      .sheet(item: $viewing) { ref in
        ImageViewer(sessionId: sessionId, ref: ref)
          .frame(minWidth: 640, minHeight: 480)
      }
    #endif
  }
}

/// An image fetched with the device token (and cached by Core's ImageLoader).
struct AuthImage: View {
  @Environment(AppModel.self) private var model
  let sessionId: String
  let ref: ImageRef
  var width: Int?
  var contentMode: ContentMode = .fill
  @State private var image: PlatformImage?
  @State private var failed = false

  var body: some View {
    ZStack {
      if let image {
        Image(platformImage: image)
          .resizable()
          .aspectRatio(contentMode: contentMode)
      } else if failed {
        Image(systemName: "photo.badge.exclamationmark")
          .foregroundStyle(.secondary)
      } else {
        Rectangle().fill(.fill.tertiary)
        ProgressView()
      }
    }
    .task(id: "\(ref.id)-\(width ?? 0)") {
      guard let loader = model.images else { return }
      do {
        let data = try await loader.data(sessionId: sessionId, imageId: ref.id, width: width)
        image = PlatformImage(data: data)
        failed = image == nil
      } catch {
        failed = true
      }
    }
  }
}

/// Full-screen image: pinch or scroll to zoom, double-tap to reset, share.
struct ImageViewer: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var model
  let sessionId: String
  let ref: ImageRef
  @State private var scale: CGFloat = 1
  @State private var base: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var baseOffset: CGSize = .zero
  @State private var data: Data?

  var body: some View {
    ZStack(alignment: .top) {
      Color.black.ignoresSafeArea()
      AuthImage(sessionId: sessionId, ref: ref, width: nil, contentMode: .fit)
        .scaleEffect(scale)
        .offset(offset)
        .gesture(
          MagnifyGesture()
            .onChanged { v in scale = max(1, min(8, base * v.magnification)) }
            .onEnded { _ in base = scale }
            .simultaneously(
              with: DragGesture()
                .onChanged { v in
                  guard scale > 1 else { return }
                  offset = CGSize(width: baseOffset.width + v.translation.width, height: baseOffset.height + v.translation.height)
                }
                .onEnded { _ in baseOffset = offset })
        )
        .onTapGesture(count: 2) {
          withAnimation(.snappy) {
            if scale > 1 {
              scale = 1
              offset = .zero
            } else {
              scale = 2.5
            }
            base = scale
            baseOffset = offset
          }
        }
        .ignoresSafeArea()
        .accessibilityIdentifier("image-viewer-image")
      HStack {
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark").font(.headline).frame(width: 44, height: 44)
        }
        .buttonStyle(.glass)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("image-viewer-close")
        Spacer()
        if let data, let img = PlatformImage(data: data) {
          ShareLink(
            item: Image(platformImage: img), preview: SharePreview(ref.name ?? "Image", image: Image(platformImage: img))
          ) {
            Image(systemName: "square.and.arrow.up").font(.headline).frame(width: 44, height: 44)
          }
          .buttonStyle(.glass)
        }
      }
      .padding()
    }
    .task {
      data = try? await model.images?.data(sessionId: sessionId, imageId: ref.id)
    }
    .axContainer("image-viewer")
  }
}
