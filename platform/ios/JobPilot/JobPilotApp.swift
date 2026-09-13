import AuthenticationServices
import CryptoKit
import Security
import SwiftUI

struct Candidate: Codable {
  var name = "", country = "US", role = "", skills = "", experience = "", languages = "",
    workRights = "", constraints = ""
  var remote = true
}
struct AgentEvent: Codable, Identifiable {
  var seq: Int
  var ts: String
  var type: String
  var attrs: Attributes?
  var id: Int { seq }
  struct Attributes: Codable { var label: String? }
}
struct Evaluation: Codable {
  var score: Int
  var eligibility: String
  var language: String
  var reason: String
  var evidence: [String]
  var gaps: [String]
}
struct Draft: Codable {
  var coverLetter: String
  var cvBullets: [String]
  var verificationNotes: [String]
}
struct Job: Codable, Identifiable {
  var id: String
  var title: String
  var company: String
  var location: String
  var url: String
  var evaluation: Evaluation?
  var draft: Draft?
  var canDraft: Bool { evaluation?.eligibility == "PASS" && evaluation?.language != "FAIL" }
}
struct AgentRun: Codable, Identifiable {
  var id: String
  var status: String
  var stage: String
  var createdAt: String
  var query: String?
  var error: String?
  var jobs: [Job]
  var events: [AgentEvent]
}
struct AccountSnapshot: Codable {
  var profile: Candidate?
  var runs: [AgentRun]
  var used: Int
  var limit: Int
  var demo: Bool
  var entitlement: Entitlement
  struct Entitlement: Codable {
    var active: Bool
    var status: String
  }
}
struct ServerConfig: Codable {
  var demo: Bool
  var issuer: String
  var clientId: String
  var iosClientId: String?
  var audience: String
}
struct EmptyResponse: Codable { var ok: Bool? }
struct APIError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

@MainActor
final class AgentStore: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding
{
  @Published var account: AccountSnapshot?
  @Published var profile = Candidate()
  @Published var message: String?
  @Published var busy = false
  @Published var connected = false
  @Published var server = UserDefaults.standard.string(forKey: "server") ?? "http://localhost:8797"
  private var authSession: ASWebAuthenticationSession?
  private var config: ServerConfig?
  private var token: String? {
    get { readToken() }
    set { saveToken(newValue) }
  }
  private var keychainAccount: String {
    server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }
  private func readToken() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "JobPilot.session",
      kSecAttrAccount as String: keychainAccount, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
  private func saveToken(_ value: String?) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "JobPilot.session",
      kSecAttrAccount as String: keychainAccount,
    ]
    SecItemDelete(query as CFDictionary)
    if let value {
      var record = query
      record[kSecValueData as String] = Data(value.utf8)
      record[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      SecItemAdd(record as CFDictionary, nil)
    }
  }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first(where: {
      $0.isKeyWindow
    }) ?? ASPresentationAnchor()
  }
  private func baseURL() throws -> URL {
    guard let url = URL(string: server), url.host != nil, url.user == nil, url.password == nil
    else { throw APIError(message: "Enter a valid server URL") }
    #if DEBUG
      let local = url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")
    #else
      let local = false
    #endif
    guard url.scheme == "https" || local else {
      throw APIError(message: "Use HTTPS for your server")
    }
    return url
  }
  func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws
    -> T
  {
    let base = try baseURL()
    let url = base.appendingPathComponent("api").appendingPathComponent(path)
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.timeoutInterval = 45
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode)
    else {
      let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw APIError(
        message: error?["error"] as? String ?? "The server could not complete this request")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
  func perform(_ action: () async throws -> Void) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do { try await action() } catch { message = error.localizedDescription }
  }
  func connect() async {
    await perform {
      account = nil
      connected = false
      let c: ServerConfig = try await request("config")
      config = c
      UserDefaults.standard.set(server, forKey: "server")
      if !c.demo && token == nil { try await signIn(c) }
      try await refresh()
      connected = true
    }
  }
  private func random() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw APIError(message: "Could not create a secure sign-in session")
    }
    return base64(Data(bytes))
  }
  private func base64(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
  private func signIn(_ c: ServerConfig) async throws {
    guard let client = c.iosClientId, !client.isEmpty, let issuer = URL(string: c.issuer),
      issuer.scheme == "https"
    else { throw APIError(message: "Configure the native OAuth client on your server") }
    let verifier = try random()
    let state = try random()
    let challenge = base64(Data(SHA256.hash(data: Data(verifier.utf8))))
    let callback = "jobpilot://oauth"
    var url = URLComponents(
      url: issuer.appendingPathComponent("authorize"), resolvingAgainstBaseURL: false)!
    url.queryItems = [
      "client_id": client, "response_type": "code", "redirect_uri": callback,
      "scope": "openid profile email", "audience": c.audience, "state": state,
      "code_challenge": challenge, "code_challenge_method": "S256",
    ].map { URLQueryItem(name: $0.key, value: $0.value) }
    let result: URL = try await withCheckedThrowingContinuation { continuation in
      authSession = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "jobpilot") {
        callback, error in
        if let callback {
          continuation.resume(returning: callback)
        } else {
          continuation.resume(throwing: error ?? APIError(message: "Sign-in cancelled"))
        }
      }
      authSession?.presentationContextProvider = self
      if authSession?.start() != true {
        continuation.resume(throwing: APIError(message: "Could not open sign-in"))
      }
    }
    let values = URLComponents(url: result, resolvingAgainstBaseURL: false)?.queryItems ?? []
    guard values.first(where: { $0.name == "state" })?.value == state,
      let code = values.first(where: { $0.name == "code" })?.value
    else { throw APIError(message: "Sign-in response failed validation") }
    var req = URLRequest(url: issuer.appendingPathComponent("oauth/token"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: [
      "grant_type": "authorization_code", "client_id": client, "code": code,
      "code_verifier": verifier, "redirect_uri": callback,
    ])
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let access = body["access_token"] as? String
    else { throw APIError(message: "Sign-in exchange failed") }
    token = access
  }
  func refresh() async throws {
    let snapshot: AccountSnapshot = try await request("account")
    account = snapshot
  }
  func saveProfile() async {
    await perform {
      let _: EmptyResponse = try await request(
        "profile", method: "PUT", body: JSONEncoder().encode(profile))
      try await refresh()
      message = "Profile saved"
    }
  }
  func startRun() async {
    await perform {
      let body = try JSONSerialization.data(withJSONObject: [
        "requestId": UUID().uuidString.lowercased()
      ])
      let _: AgentRun = try await request("runs", method: "POST", body: body)
      try await refresh()
    }
  }
  func control(_ run: AgentRun, _ action: String) async {
    await perform {
      let _: AgentRun = try await request(
        "runs/\(run.id)/control", method: "POST",
        body: JSONSerialization.data(withJSONObject: ["action": action]))
      try await refresh()
    }
  }
  func approve(_ run: AgentRun, _ ids: Set<String>) async {
    await perform {
      let _: AgentRun = try await request(
        "runs/\(run.id)/decisions", method: "POST",
        body: JSONSerialization.data(withJSONObject: ["approvedIds": Array(ids)]))
      try await refresh()
    }
  }
  func signOut() {
    token = nil
    account = nil
    connected = false
  }
}

@main struct JobPilotApp: App {
  @StateObject private var store = AgentStore()
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(store).tint(Color(red: 0.14, green: 0.32, blue: 0.26))
    }
  }
}
struct RootView: View {
  @EnvironmentObject var store: AgentStore
  var body: some View {
    Group {
      if store.connected {
        TabView {
          NavigationStack { MissionView() }.tabItem { Label("Mission", systemImage: "sparkles") }
          NavigationStack { ProfileView() }.tabItem {
            Label("Profile", systemImage: "person.crop.circle")
          }
          NavigationStack { SettingsView() }.tabItem { Label("Settings", systemImage: "gearshape") }
        }
      } else {
        NavigationStack { SettingsView() }
      }
    }
    .task {
      while !Task.isCancelled {
        if store.connected && !store.busy
          && store.account?.runs.contains(where: { $0.status == "running" }) == true
        {
          try? await store.refresh()
        }
        try? await Task.sleep(for: .seconds(4))
      }
    }
    .alert(
      "JobPilot",
      isPresented: Binding(get: { store.message != nil }, set: { if !$0 { store.message = nil } })
    ) {
      Button("OK") { store.message = nil }
    } message: {
      Text(store.message ?? "")
    }
  }
}
struct MissionView: View {
  @EnvironmentObject var store: AgentStore
  var body: some View {
    List {
      Section {
        Text("Your next chapter.").font(.system(size: 34, design: .serif))
        Text("Your agent does the legwork. You make the decisions.").foregroundStyle(.secondary)
        if store.account?.demo == true {
          Label("Local demo · fixture data", systemImage: "testtube.2").font(.caption)
            .foregroundStyle(.orange)
        }
        Button("Start a new search", systemImage: "plus") { Task { await store.startRun() } }
          .disabled(
            store.busy || store.account?.profile == nil
              || store.account?.runs.contains(where: {
                ["running", "paused", "review", "failed"].contains($0.status)
              }) == true)
      }
      if let account = store.account {
        Section("Your runs") {
          ForEach(account.runs) { run in
            NavigationLink {
              RunView(runID: run.id)
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                Text(run.query ?? "Planning your search").font(.headline)
                Text("\(run.status.capitalized) · \(run.jobs.count) opportunities").font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }
      Section {
        Label("Applications are never submitted automatically.", systemImage: "checkmark.shield")
          .font(.caption)
      }
    }.navigationTitle("JobPilot").refreshable { try? await store.refresh() }
  }
}
struct RunView: View {
  @EnvironmentObject var store: AgentStore
  let runID: String
  @State private var selected = Set<String>()
  var body: some View {
    if let run = store.account?.runs.first(where: { $0.id == runID }) {
      List {
        Section {
          Text(run.query ?? "Search plan").font(.title2)
          Text(run.status.capitalized).foregroundStyle(.secondary)
          if let error = run.error { Text(error).foregroundStyle(.red) }
          HStack {
            if run.status == "running" {
              Button("Pause") { Task { await store.control(run, "pause") } }
            }
            if run.status == "paused" {
              Button("Resume") { Task { await store.control(run, "resume") } }
            }
            if run.status == "failed" {
              Button("Retry") { Task { await store.control(run, "retry") } }
            }
            if !["completed", "cancelled"].contains(run.status) {
              Button("Cancel", role: .destructive) { Task { await store.control(run, "cancel") } }
            }
          }.buttonStyle(.bordered).disabled(store.busy)
        }
        Section("Opportunities") {
          ForEach(run.jobs) { job in
            VStack(alignment: .leading, spacing: 10) {
              Text(job.title).font(.headline)
              Text("\(job.company) · \(job.location)").font(.subheadline).foregroundStyle(
                .secondary)
              if let evaluation = job.evaluation {
                Text(
                  "Fit \(evaluation.score)/100 · Rights: \(evaluation.eligibility) · Language: \(evaluation.language)"
                ).font(.caption)
                Text(evaluation.reason).font(.subheadline)
                DisclosureGroup("Evidence & gaps") {
                  ForEach(evaluation.evidence, id: \.self) { Text($0).font(.caption) }
                  ForEach(evaluation.gaps, id: \.self) {
                    Text($0).font(.caption).foregroundStyle(.secondary)
                  }
                }
              }
              if let url = URL(string: job.url), url.scheme == "https" {
                Link("View posting ↗", destination: url)
              }
              if run.status == "review" {
                Toggle(
                  job.canDraft ? "Prepare application draft" : "Not cleared for drafting",
                  isOn: Binding(
                    get: { selected.contains(job.id) },
                    set: { if $0 { selected.insert(job.id) } else { selected.remove(job.id) } })
                ).disabled(!job.canDraft)
              }
              if let draft = job.draft {
                DisclosureGroup("Read application draft") {
                  Text(draft.coverLetter).textSelection(.enabled)
                  ForEach(draft.cvBullets, id: \.self) { Text("• " + $0) }
                  ForEach(draft.verificationNotes, id: \.self) {
                    Text($0).font(.caption).foregroundStyle(.secondary)
                  }
                  Text("Unverified text draft · Check before use").font(.caption).bold()
                }
              }
            }.padding(.vertical, 8)
          }
        }
        if run.status == "review" {
          Section {
            Button("Finish review & prepare drafts") { Task { await store.approve(run, selected) } }
              .disabled(store.busy)
            Text(
              "Only jobs with verified eligibility can be drafted. Nothing is sent to employers."
            ).font(.caption).foregroundStyle(.secondary)
          }
        }
        Section("Run timeline") {
          ForEach(run.events) { event in
            VStack(alignment: .leading) {
              Text(event.attrs?.label ?? event.type)
              Text(event.type).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }.navigationTitle("Agent run").refreshable { try? await store.refresh() }
    } else {
      ContentUnavailableView("Run unavailable", systemImage: "clock")
    }
  }
}
struct ProfileView: View {
  @EnvironmentObject var store: AgentStore
  var body: some View {
    Form {
      Section("Your direction") {
        TextField("Name", text: $store.profile.name)
        TextField("Target role", text: $store.profile.role)
        TextField("Country code (US, GB, DK…)", text: $store.profile.country)
          .textInputAutocapitalization(.characters)
        Toggle("Remote roles only", isOn: $store.profile.remote)
      }
      Section("Facts your agent can use") {
        TextField("Skills", text: $store.profile.skills, axis: .vertical)
        TextField(
          "Experience (at least 20 characters)", text: $store.profile.experience, axis: .vertical)
        TextField("Languages and proficiency", text: $store.profile.languages, axis: .vertical)
        TextField(
          "Citizenship / work authorization", text: $store.profile.workRights, axis: .vertical)
        TextField("Constraints and preferences", text: $store.profile.constraints, axis: .vertical)
      }
      Section {
        Text(
          "Your profile is sent to Workers AI to plan and evaluate searches. Only share facts you want used in your applications."
        ).font(.caption).foregroundStyle(.secondary)
        Button("Save profile") { Task { await store.saveProfile() } }.disabled(store.busy)
      }
    }.navigationTitle("Your profile").onAppear {
      if let p = store.account?.profile { store.profile = p }
    }
  }
}
struct SettingsView: View {
  @EnvironmentObject var store: AgentStore
  var body: some View {
    Form {
      Section {
        Text("JobPilot").font(.system(size: 38, design: .serif))
        Text("Your job-search agent, wherever you are.").foregroundStyle(.secondary)
      }
      Section("Connect to your workspace") {
        TextField("https://your-worker.example", text: $store.server).keyboardType(.URL)
          .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(store.connected)
        Button(store.connected ? "Refresh connection" : "Connect & sign in") {
          Task { await store.connect() }
        }.disabled(store.busy)
        if store.busy { ProgressView() }
      }
      if let account = store.account {
        Section("Membership") {
          Text(account.demo ? "Local demo" : account.entitlement.status.capitalized)
          Text("\(account.used) / \(account.limit) searches this month")
          Text("This app controls an existing JobPilot account.").font(.caption).foregroundStyle(
            .secondary)
        }
      }
      if store.connected { Section { Button("Sign out", role: .destructive) { store.signOut() } } }
    }.navigationTitle("Workspace")
  }
}
