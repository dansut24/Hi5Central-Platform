import SwiftUI

struct UnifiedMobileLogin: View {
    @EnvironmentObject private var auth: UnifiedMobileAuth
    @AppStorage("hi5central.mobile.company") private var savedTenant = ""
    @State private var company = ""
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                HStack {
                    ITSMBrand(size: 65)
                    Spacer()
                    Text("ITSM + RMM")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.tint)
                }
                .padding(.top, 25)

                Text(auth.challengeToken == nil
                     ? "Welcome to Hi5Central" : "Verify your identity")
                    .font(.largeTitle.bold())

                Text(auth.challengeToken == nil
                     ? "One secure login for your company's enabled workspaces."
                     : "Enter your authenticator or recovery code.")
                    .font(.subheadline).foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 17) {
                    if auth.challengeToken == nil {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Company").font(.subheadline.weight(.medium))
                            HStack {
                                TextField("company", text: $company)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                Text(".hi5central.com")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .unifiedField()
                        }
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Work email").font(.subheadline.weight(.medium))
                            TextField("you@company.com", text: $email)
                                .textInputAutocapitalization(.never)
                                .textContentType(.username)
                                .keyboardType(.emailAddress)
                                .autocorrectionDisabled()
                                .unifiedField()
                        }
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Password").font(.subheadline.weight(.medium))
                            SecureField("Password", text: $password)
                                .textContentType(.password)
                                .unifiedField()
                        }
                        Button {
                            let credential = password
                            password = ""
                            Task {
                                await auth.signIn(tenant: company,
                                                  email: email,
                                                  password: credential)
                                if auth.authenticated { savedTenant = auth.tenant }
                            }
                        } label: {
                            HStack(spacing: 9) {
                                if auth.busy { ProgressView().tint(.white) }
                                Text("Sign in")
                                Image(systemName: "arrow.right")
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(auth.busy || company.isEmpty
                                  || email.isEmpty || password.isEmpty)
                    } else {
                        if let secret = auth.setupSecret {
                            VStack(alignment: .leading, spacing: 7) {
                                Label("Set up an authenticator", systemImage: "lock.shield")
                                    .font(.headline)
                                Text(secret)
                                    .font(.system(.subheadline, design: .monospaced))
                                    .textSelection(.enabled)
                                    .unifiedField()
                                if let uri = auth.setupURI, let url = URL(string: uri) {
                                    ShareLink("Share authenticator link", item: url)
                                }
                            }
                        }
                        TextField("Authenticator / recovery code", text: $code)
                            .textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .unifiedField()
                        Button {
                            Task {
                                await auth.verify(code)
                                if auth.authenticated { savedTenant = auth.tenant }
                            }
                        } label: {
                            HStack {
                                if auth.busy { ProgressView().tint(.white) }
                                Text("Verify and continue")
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(auth.busy || code.isEmpty)
                        Button("Back to sign in") {
                            auth.cancelMFA()
                            code = ""
                        }
                    }

                    if let error = auth.errorMessage {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(18)
                .background(Color(uiColor: .secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 18))

                Label("Access to ITSM and RMM is determined by your company subscription and your staff permissions. Credentials are not saved in this app.",
                      systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Text("Hi5Central Mobile · integrated native preview")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 25)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { if company.isEmpty { company = savedTenant } }
    }
}

private extension View {
    func unifiedField() -> some View {
        padding(14)
            .background(Color(uiColor: .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 11))
    }
}
