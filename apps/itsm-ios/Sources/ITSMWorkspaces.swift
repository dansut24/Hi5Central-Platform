import SwiftUI

struct ITSMTasksView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var search = ""
    @State private var selectedTask: ITSMTask?

    private var filtered: [ITSMTask] {
        client.tasks.filter {
            search.isEmpty
                || [$0.title, $0.status, $0.reference, $0.assignedTo]
                    .joined(separator: " ")
                    .localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        List {
            if let issue = client.tasksMessage {
                Section {
                    Label(issue, systemImage: "exclamationmark.circle")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
            Section("\(filtered.count) active tasks") {
                ForEach(filtered) { task in
                    Button { selectedTask = task } label: {
                        VStack(alignment: .leading, spacing: 5) {
                        Text(task.title.isEmpty ? "Untitled task" : task.title)
                            .font(.subheadline.weight(.semibold))
                        HStack {
                            Text(task.reference).font(.caption2.weight(.medium))
                                .foregroundStyle(.tint)
                            Spacer()
                            Text(task.status).font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if !task.assignedTo.isEmpty {
                            Label(task.assignedTo, systemImage: "person")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                }
                if filtered.isEmpty {
                    Text("No active tasks match your search.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Tasks")
        .searchable(text: $search, prompt: "Find a task")
        .refreshable { await client.refreshTasks() }
        .sheet(item: $selectedTask) { task in
            ITSMTaskDetail(task: task).environmentObject(client)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await client.refreshTasks() }
                } label: { Image(systemName: "arrow.clockwise") }
            }
        }
    }
}

struct ITSMKnowledgeView: View {
    @EnvironmentObject private var client: ITSMClient
    @State private var search = ""
    @State private var selected: ITSMArticle?

    private var filtered: [ITSMArticle] {
        client.articles.filter {
            search.isEmpty
                || [$0.title, $0.summary, $0.category, $0.id]
                    .joined(separator: " ")
                    .localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        List {
            if let issue = client.knowledgeMessage {
                Section {
                    Label(issue, systemImage: "exclamationmark.circle")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
            Section("\(filtered.count) knowledge articles") {
                ForEach(filtered) { article in
                    Button { selected = article } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(article.title).font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                            Text(article.summary.isEmpty ? article.category : article.summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            HStack {
                                Text(article.category)
                                Spacer()
                                Text(article.status)
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                }
                if filtered.isEmpty {
                    Text("No knowledge articles found.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Knowledge")
        .searchable(text: $search, prompt: "Search articles")
        .refreshable { await client.refreshKnowledge() }
        .sheet(item: $selected) { article in
            ITSMKnowledgeDetail(article: article)
        }
    }
}

struct ITSMKnowledgeDetail: View {
    let article: ITSMArticle
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(article.title)
                        .font(.title2.bold())
                    HStack {
                        Label(article.category.isEmpty ? "Knowledge" : article.category,
                              systemImage: "books.vertical")
                        Spacer()
                        Text(article.status)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    if !article.summary.isEmpty {
                        Text(article.summary)
                            .font(.subheadline.weight(.medium))
                    }
                    Text(article.body.isEmpty
                         ? "This article has no plain-text body available in the current API response."
                         : article.body)
                        .font(.body)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
            }
            .navigationTitle("Article")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct ITSMNotificationsView: View {
    @EnvironmentObject private var client: ITSMClient

    var body: some View {
        List {
            Section("\(client.notifications.filter { ($0["read"] as? Bool) != true }.count) unread") {
                ForEach(Array(client.notifications.enumerated()), id: \.offset) { pair in
                    let notice = pair.element
                    Button {
                        Task { await client.markNotificationRead(notice) }
                    } label: {
                        HStack(alignment: .top, spacing: 11) {
                            Image(systemName: (notice["read"] as? Bool) == true
                                  ? "bell" : "bell.badge")
                                .foregroundStyle((notice["read"] as? Bool) == true
                                                 ? Color.secondary : Color.accentColor)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(itsmString(notice["title"]))
                                    .font(.subheadline.weight(.semibold))
                                Text(itsmString(notice["body"]))
                                    .font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(3)
                                Text(itsmDate(itsmString(notice["createdAt"])))
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                            Spacer(minLength: 4)
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                }
                if client.notifications.isEmpty {
                    Label("No notifications", systemImage: "bell.slash")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Notifications")
        .refreshable { await client.refreshNotifications() }
    }
}

struct ITSMGlobalSearch: View {
    @EnvironmentObject private var client: ITSMClient
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var selectedRecord: ITSMRecord?
    @State private var selectedArticle: ITSMArticle?

    private var matchingRecords: [ITSMRecord] {
        guard !text.isEmpty else { return Array(client.records.prefix(8)) }
        return Array(client.records.filter {
            [$0.id, $0.title, $0.requester, $0.service, $0.team, $0.type]
                .joined(separator: " ").localizedCaseInsensitiveContains(text)
        }.prefix(50))
    }

    private var matchingArticles: [ITSMArticle] {
        guard !text.isEmpty else { return [] }
        return Array(client.articles.filter {
            [$0.title, $0.category, $0.summary]
                .joined(separator: " ").localizedCaseInsensitiveContains(text)
        }.prefix(25))
    }

    private var matchingTasks: [ITSMTask] {
        guard !text.isEmpty else { return [] }
        return Array(client.tasks.filter {
            [$0.title, $0.reference, $0.assignedTo]
                .joined(separator: " ").localizedCaseInsensitiveContains(text)
        }.prefix(25))
    }

    var body: some View {
        NavigationStack {
            List {
                if !matchingRecords.isEmpty {
                    Section("Records") {
                        ForEach(matchingRecords) { record in
                            Button { selectedRecord = record } label: {
                                ITSMRecordRow(record: record)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if !matchingTasks.isEmpty {
                    Section("Tasks") {
                        ForEach(matchingTasks) { task in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(task.title).font(.subheadline.weight(.medium))
                                Text(task.reference)
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !matchingArticles.isEmpty {
                    Section("Knowledge") {
                        ForEach(matchingArticles) { article in
                            Button { selectedArticle = article } label: {
                                Text(article.title).font(.subheadline)
                            }
                        }
                    }
                }
                if !text.isEmpty && matchingRecords.isEmpty
                    && matchingTasks.isEmpty && matchingArticles.isEmpty {
                    Label("No results for “\(text)”", systemImage: "magnifyingglass")
                        .foregroundStyle(.secondary)
                }
            }
            .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Search ITSM records, tasks and knowledge")
            .navigationTitle("Search ITSM")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .sheet(item: $selectedRecord) { record in
                ITSMRecordDetail(record: record).environmentObject(client)
            }
            .sheet(item: $selectedArticle) { article in
                ITSMKnowledgeDetail(article: article)
            }
        }
    }
}

struct ITSMMoreView: View {
    @EnvironmentObject private var client: ITSMClient
    @AppStorage("hi5central.itsm.appearance") private var appearance = "system"
    @State private var showingNotifications = false

    var body: some View {
        List {
            Section("ITSM workspaces") {
                NavigationLink {
                    ITSMApprovalsView()
                } label: {
                    Label("Approvals", systemImage: "checkmark.shield")
                }
                NavigationLink {
                    ITSMDirectoryView()
                } label: {
                    Label("People and teams", systemImage: "person.2")
                }
                NavigationLink {
                    ITSMCMDBView()
                } label: {
                    Label("CMDB", systemImage: "server.rack")
                }
                NavigationLink {
                    ITSMProjectsView()
                } label: {
                    Label("Projects", systemImage: "square.stack.3d.up")
                }
                NavigationLink {
                    ITSMCalendarView()
                } label: {
                    Label("Calendar", systemImage: "calendar")
                }
            }
            Section("My workspace") {
                LabeledContent("Company", value: client.companyName)
                LabeledContent("Account", value: client.userName)
                LabeledContent("Environment", value: "Production")
            }
            Section("Notifications") {
                Button {
                    showingNotifications = true
                } label: {
                    HStack {
                        Label("Notification centre", systemImage: "bell")
                        Spacer()
                        Text("\(client.notifications.filter { ($0["read"] as? Bool) != true }.count) unread")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Section("Appearance") {
                Picker("Display", selection: $appearance) {
                    Text("Automatic").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            }
            Section("Account") {
                Button("Sign out", role: .destructive) {
                    Task { await client.signOut() }
                }
            }
            Section {
                Text("Hi5Central ITSM iOS v0.2.0 — native technician preview. MFA and tenant access are enforced by the existing Hi5Central API.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("More")
        .sheet(isPresented: $showingNotifications) {
            NavigationStack {
                ITSMNotificationsView()
                    .environmentObject(client)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showingNotifications = false }
                        }
                    }
            }
        }
    }
}
