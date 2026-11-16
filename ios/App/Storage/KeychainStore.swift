import Foundation
import Security

/// Tokens and API keys are credentials: they live in the Keychain, never in `UserDefaults`.
///
/// One generic-password item per account; the service scopes independent credential
/// families (daemon connections vs. the ASR provider key).
enum KeychainStore {
    private static let defaultService = "com.noresign.paboot.connection"

    static func set(_ value: String, for account: String, service: String = defaultService) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)

        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ account: String, service: String = defaultService) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ account: String, service: String = defaultService) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// DeepSeek API key used only by on-device voice transcription.
enum AsrKeyStore {
    private static let service = "com.noresign.paboot.asr"
    private static let account = "deepseek.api-key"

    static var apiKey: String? { KeychainStore.get(account, service: service) }

    static var isConfigured: Bool {
        guard let key = apiKey else { return false }
        return !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func set(_ value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            KeychainStore.delete(account, service: service)
        } else {
            _ = KeychainStore.set(trimmed, for: account, service: service)
        }
    }
}
