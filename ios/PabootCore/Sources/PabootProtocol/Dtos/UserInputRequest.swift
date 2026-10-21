import Foundation

/// Provider input is answered on the original permission, without starting a new turn.
public struct UserInputRequest {
    public struct Field {
        public let id: String
        public let title: String
        public let description: String?
        public let type: String
        public let required: Bool
        public let secret: Bool
        public let options: [String]
    }

    public let kind: String
    public let message: String?
    public let url: String?
    public let fields: [Field]

    public init(_ input: JSONValue?) {
        kind = input?["kind"]?.stringValue ?? "unsupported"
        message = input?["message"]?.stringValue
        url = input?["url"]?.stringValue
        if kind == "questions", case .array(let questions)? = input?["questions"] {
            fields = questions.compactMap { question in
                guard let id = question["id"]?.stringValue else { return nil }
                let options: [String]
                if case .array(let values)? = question["options"] {
                    options = values.compactMap { $0["label"]?.stringValue }
                } else {
                    options = []
                }
                return Field(id: id, title: question["question"]?.stringValue ?? id,
                             description: question["header"]?.stringValue, type: "string",
                             required: true, secret: question["isSecret"] == .bool(true), options: options)
            }
        } else if kind == "form",
                  case .object(let properties)? = input?["requestedSchema"]?["properties"] {
            let required: Set<String>
            if case .array(let values)? = input?["requestedSchema"]?["required"] {
                required = Set(values.compactMap(\.stringValue))
            } else {
                required = []
            }
            fields = properties.keys.sorted().map { key in
                let field = properties[key]
                let choices = field?["enum"] ?? field?["oneOf"]
                    ?? field?["items"]?["enum"] ?? field?["items"]?["anyOf"]
                let options: [String]
                if case .array(let values)? = choices {
                    options = values.compactMap { $0.stringValue ?? $0["const"]?.stringValue }
                } else {
                    options = []
                }
                return Field(id: key, title: field?["title"]?.stringValue ?? key,
                             description: field?["description"]?.stringValue,
                             type: field?["type"]?.stringValue ?? "string",
                             required: required.contains(key), secret: false, options: options)
            }
        } else {
            fields = []
        }
    }

    public var canSubmit: Bool { ["questions", "form", "url"].contains(kind) }

    public func response(values: [String: String]) throws -> JSONValue {
        guard canSubmit else { throw InputError("暂不支持这种输入方式，请拒绝请求") }
        if kind == "url" { return .null }
        var result: [String: JSONValue] = [:]
        for field in fields {
            let value = values[field.id] ?? ""
            if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if field.required { throw InputError("请填写：\(field.title)") }
                continue
            }
            if kind == "questions" {
                result[field.id] = .object(["answers": .array([.string(value)])])
                continue
            }
            if field.type == "string" {
                result[field.id] = .string(value)
                continue
            }
            guard let data = value.data(using: .utf8),
                  let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) else {
                throw InputError("\(field.title)：输入格式不正确")
            }
            switch (field.type, parsed) {
            case ("boolean", .bool): break
            case ("number", .number(let number)) where number.isFinite: break
            case ("integer", .number(let number)) where number.isFinite && number.rounded() == number: break
            case ("array", .array(let items)) where items.allSatisfy({ $0.stringValue != nil }): break
            default: throw InputError("\(field.title)：输入类型不正确")
            }
            result[field.id] = parsed
        }
        return kind == "questions" ? .object(["answers": .object(result)]) : .object(result)
    }

    private struct InputError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}
