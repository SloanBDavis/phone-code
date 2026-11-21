import PhoneCodeCore
import SwiftUI

/// iPhone and iPad: the sidebar of chats and the chat. On iPhone the split
/// view collapses: the app opens into the chat, the sidebar is one swipe or
/// the back button away (the native counterpart of the web app's drawer).
struct PhoneMainView: View {
  @Environment(AppModel.self) private var model
  @State private var column: NavigationSplitViewColumn = .detail
  @State private var visibility: NavigationSplitViewVisibility = .automatic

  var body: some View {
    NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: $column) {
      SidebarView(onOpen: { column = .detail })
    } detail: {
      NavigationStack {
        ChatScreen(route: model.route)
          .id(model.route)
      }
    }
  }
}
