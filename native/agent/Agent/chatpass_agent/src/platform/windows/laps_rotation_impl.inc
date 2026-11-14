// Hi5Central Local Admin Protection Windows adapter.
// Included INSIDE windows_service.cpp anonymous namespace after HTTPS helper declarations.
// This adapter NEVER puts the password in job results, normal logs, telemetry or inventory.
struct LocalAdminSensitivePassword {
    std::string value;
    ~LocalAdminSensitivePassword() {
        if (!value.empty()) SecureZeroMemory(value.data(), value.size());
    }
    LocalAdminSensitivePassword(const LocalAdminSensitivePassword&) = delete;
    LocalAdminSensitivePassword& operator=(const LocalAdminSensitivePassword&) = delete;
    LocalAdminSensitivePassword() = default;
    LocalAdminSensitivePassword(LocalAdminSensitivePassword&& other) noexcept : value(std::move(other.value)) {}
};
static bool IsHi5LocalAdminName(const std::string& name) {
    if (name.size() < 7 || name.size() > 20 || name.rfind("Hi5", 0) != 0 ||
        name == "Hi5Administrator") return false;
    for (unsigned char ch : name) {
        if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
              (ch >= '0' && ch <= '9') || ch == '_' || ch == '-')) return false;
    }
    return true;
}
static bool IsNativeLapsCurrentlyManagingAccounts() {
    constexpr const wchar_t* policyRoots[] = {
        L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\LAPS",
        L"SOFTWARE\\Microsoft\\Policies\\LAPS",
        L"SOFTWARE\\Policies\\Microsoft\\Windows\\LAPS",
    };
    for (const auto* root : policyRoots) {
        HKEY key = nullptr;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, root, 0, KEY_READ, &key) != ERROR_SUCCESS) continue;
        DWORD value = 0, kind = 0, size = sizeof(value);
        const auto status = RegQueryValueExW(key, L"BackupDirectory", nullptr, &kind,
                                           reinterpret_cast<LPBYTE>(&value), &size);
        RegCloseKey(key);
        if (status == ERROR_SUCCESS && kind == REG_DWORD && (value == 1 || value == 2)) return true;
    }
    HKEY legacy = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Policies\\Microsoft Services\\AdmPwd", 0, KEY_READ, &legacy) == ERROR_SUCCESS) {
        DWORD value = 0, kind = 0, size = sizeof(value);
        const auto status = RegQueryValueExW(legacy, L"AdmPwdEnabled", nullptr, &kind,
                                           reinterpret_cast<LPBYTE>(&value), &size);
        RegCloseKey(legacy);
        if (status == ERROR_SUCCESS && kind == REG_DWORD && value != 0) return true;
    }
    return false;
}
static bool IsWindowsDomainController() {
    LPBYTE buffer = nullptr;
    const NET_API_STATUS rc = NetServerGetInfo(nullptr, 101, &buffer);
    if (rc != NERR_Success || !buffer) return true; // Fail closed when machine role is unknown.
    auto* info = reinterpret_cast<SERVER_INFO_101*>(buffer);
    const bool isDc = (info->sv101_type & (SV_TYPE_DOMAIN_CTRL | SV_TYPE_DOMAIN_BAKCTRL)) != 0;
    NetApiBufferFree(buffer);
    return isDc;
}
static std::string ManagedAccountSid(const std::wstring& name) {
    LPBYTE info = nullptr;
    const NET_API_STATUS rc = NetUserGetInfo(nullptr, name.c_str(), 4, &info);
    if (rc == NERR_UserNotFound) return "";
    if (rc != NERR_Success || !info) throw std::runtime_error("Cannot inspect dedicated local administrator identity");
    auto* record = reinterpret_cast<USER_INFO_4*>(info);
    LPWSTR sid = nullptr;
    std::string value;
    if (record->usri4_user_sid && ConvertSidToStringSidW(record->usri4_user_sid, &sid) && sid) {
        value = WideToUtf8(sid);
        LocalFree(sid);
    }
    NetApiBufferFree(info);
    if (value.empty()) throw std::runtime_error("Failed to read dedicated local account SID");
    return value;
}
static std::wstring LocalAdministratorsGroupName() {
    BYTE sidBuffer[SECURITY_MAX_SID_SIZE]{};
    DWORD sidBytes = sizeof(sidBuffer);
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, sidBuffer, &sidBytes))
        throw std::runtime_error("Cannot resolve local Administrators SID");
    wchar_t name[256]{}, domain[256]{};
    DWORD nameSize = static_cast<DWORD>(std::size(name));
    DWORD domainSize = static_cast<DWORD>(std::size(domain));
    SID_NAME_USE use{};
    if (!LookupAccountSidW(nullptr, sidBuffer, name, &nameSize, domain, &domainSize, &use))
        throw std::runtime_error("Cannot identify local Administrators group");
    return std::wstring(name);
}
static void AddDedicatedAdminToLocalAdministrators(const std::wstring& accountName) {
    std::wstring principal = L".\\" + accountName;
    LOCALGROUP_MEMBERS_INFO_3 membership{};
    membership.lgrmi3_domainandname = principal.data();
    const auto status = NetLocalGroupAddMembers(nullptr, LocalAdministratorsGroupName().c_str(), 3,
                                               reinterpret_cast<LPBYTE>(&membership), 1);
    if (status != NERR_Success && status != ERROR_MEMBER_IN_ALIAS)
        throw std::runtime_error("Could not add the dedicated account to local Administrators");
}
static LocalAdminSensitivePassword GenerateManagedPassword() {
    LocalAdminSensitivePassword password;
    constexpr const char* chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+?@^_~-";
    constexpr const char* upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    constexpr const char* lower = "abcdefghijkmnopqrstuvwxyz";
    constexpr const char* numeric = "23456789";
    constexpr const char* symbol = "!#$%&*+?@^_~-";
    std::array<unsigned char, 128> randomData{};
    const NTSTATUS status = BCryptGenRandom(nullptr,randomData.data(),static_cast<ULONG>(randomData.size()),
                                            BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (status < 0) throw std::runtime_error("Windows secure password generation failed");
    password.value.reserve(40);
    password.value += upper[randomData[0] % strlen(upper)];
    password.value += lower[randomData[1] % strlen(lower)];
    password.value += numeric[randomData[2] % strlen(numeric)];
    password.value += symbol[randomData[3] % strlen(symbol)];
    for (size_t i=4;i<40;i++) password.value += chars[randomData[i] % strlen(chars)];
    for (size_t i=39;i>0;i--) std::swap(password.value[i],password.value[randomData[40+i]%(i+1)]);
    SecureZeroMemory(randomData.data(),randomData.size());
    return password;
}
static json RotateDedicatedLocalAdmin(const AgentIdentity& ident, const std::string& jobId, const json& payload) {
    if (ident.apiBaseUrl.rfind("https://",0) != 0)
        throw std::runtime_error("Local administrator escrow requires HTTPS");
    const std::string accountId = payload.value("account_id",std::string());
    const std::string accountName = payload.value("account_name",std::string());
    const std::string expectedSid = payload.value("expected_sid",std::string());
    const bool allowCreate = payload.value("create",false);
    if (!IsHi5LocalAdminName(accountName) || accountId.size()!=36 || jobId.size()!=36)
        throw std::runtime_error("Invalid local administrator rotation configuration");
    if (IsWindowsDomainController()) throw std::runtime_error("Local administrator vault is not supported on domain controllers");
    if (IsNativeLapsCurrentlyManagingAccounts())
        throw std::runtime_error("Windows LAPS is active; refusing conflicting local administrator management");
    const std::wstring accountWide = Utf8ToWide(accountName);
    const std::string sidBefore = ManagedAccountSid(accountWide);
    if (sidBefore.empty() && !allowCreate)
        throw std::runtime_error("The previously managed local administrator account no longer exists");
    if (!sidBefore.empty() && (expectedSid.empty() || sidBefore != expectedSid))
        throw std::runtime_error("Existing account is unmanaged or SID has changed; refusing takeover");
    if (sidBefore.empty() && !expectedSid.empty())
        throw std::runtime_error("Managed local administrator identity was removed; refusing recreation");
    LocalAdminSensitivePassword secret = GenerateManagedPassword();
    std::string escrowBody = json{{"jobId",jobId},{"accountId",accountId},{"password",secret.value}}.dump();
    std::string escrowResponse;
    try {
        escrowResponse=HttpPostJsonWithAgentAuthResponse(ident.apiBaseUrl+"/api/v1/agent/laps/escrow",
                                                          escrowBody,ident);
    } catch (...) {
        SecureZeroMemory(escrowBody.data(),escrowBody.size());
        throw;
    }
    SecureZeroMemory(escrowBody.data(),escrowBody.size());
    const json accepted=json::parse(escrowResponse,nullptr,false);
    if (accepted.is_discarded() || !accepted.value("accepted",false))
        throw std::runtime_error("Server did not acknowledge secure password escrow");
    const std::string rotationId=accepted.value("rotationId",std::string());
    if (rotationId.size()!=36) throw std::runtime_error("Invalid escrow confirmation identity");
    std::wstring passwordWide=Utf8ToWide(secret.value);
    if (passwordWide.empty()) throw std::runtime_error("Cannot prepare generated local account password");
    NET_API_STATUS changeStatus=NERR_Success;
    if (sidBefore.empty()) {
        USER_INFO_1 newUser{};
        newUser.usri1_name=const_cast<LPWSTR>(accountWide.c_str());
        newUser.usri1_password=passwordWide.data();
        newUser.usri1_priv=USER_PRIV_USER;
        newUser.usri1_flags=UF_SCRIPT | UF_DONT_EXPIRE_PASSWD;
        DWORD parameterError=0;
        changeStatus=NetUserAdd(nullptr,1,reinterpret_cast<LPBYTE>(&newUser),&parameterError);
        if (changeStatus==NERR_Success) {
            try { AddDedicatedAdminToLocalAdministrators(accountWide); }
            catch (...) {
                // Do not leave an unmanaged privileged account behind on failed first enrolment.
                NetUserDel(nullptr,accountWide.c_str());
                SecureZeroMemory(passwordWide.data(),passwordWide.size()*sizeof(wchar_t));
                throw;
            }
        }
    } else {
        USER_INFO_1003 update{};
        update.usri1003_password=passwordWide.data();
        changeStatus=NetUserSetInfo(nullptr,accountWide.c_str(),1003,
                                    reinterpret_cast<LPBYTE>(&update),nullptr);
    }
    SecureZeroMemory(passwordWide.data(),passwordWide.size()*sizeof(wchar_t));
    if (changeStatus!=NERR_Success)
        throw std::runtime_error("Windows rejected the local administrator password change ("+std::to_string(changeStatus)+")");
    const std::string accountSid=ManagedAccountSid(accountWide);
    if (accountSid.empty() || (accountSid.size()>=4 && accountSid.substr(accountSid.size()-4)=="-500"))
        throw std::runtime_error("Dedicated administrator SID validation failed");
    const json commitPayload={{"jobId",jobId},{"rotationId",rotationId},
                              {"accountId",accountId},{"accountSid",accountSid}};
    const std::string commitResponse=HttpPostJsonWithAgentAuthResponse(
        ident.apiBaseUrl+"/api/v1/agent/laps/commit",commitPayload.dump(),ident);
    const json committed=json::parse(commitResponse,nullptr,false);
    if (committed.is_discarded() || !committed.value("accepted",false))
        throw std::runtime_error("Password changed, but vault activation acknowledgement failed");
    return json{{"status","verified"},{"mode","hi5central_vault"},{"account",accountName},
                {"account_sid",accountSid},{"rotation_id",rotationId},{"password_escrowed",true}};
}
