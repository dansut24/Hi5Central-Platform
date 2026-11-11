import SwiftUI
import UIKit

/// First responder lives in the native app. Text is streamed directly to the
/// authorised WebRTC session instead of being collected and stored locally.
struct NativeRemoteKeyboardInput: UIViewRepresentable {
    let active: Bool
    let kind: String
    let onInsert: (String) -> Void
    let onDelete: () -> Void
    let onReturn: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onInsert: onInsert, onDelete: onDelete, onReturn: onReturn)
    }

    func makeUIView(context: Context) -> RemoteKeyboardTextField {
        let field = RemoteKeyboardTextField(frame: .zero)
        field.delegate = context.coordinator
        field.deleteHandler = { [weak coordinator = context.coordinator] in
            coordinator?.onDelete()
        }
        field.placeholder = "Type on remote computer"
        field.font = UIFont.preferredFont(forTextStyle: .body)
        field.textColor = UIColor.label
        field.backgroundColor = UIColor.tertiarySystemFill
        field.layer.cornerRadius = 11
        field.leftViewMode = .always
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 10))
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.textContentType = nil
        field.inputAssistantItem.leadingBarButtonGroups = []
        field.inputAssistantItem.trailingBarButtonGroups = []
        field.accessibilityLabel = "Remote computer keyboard"
        return field
    }

    func updateUIView(_ field: RemoteKeyboardTextField, context: Context) {
        context.coordinator.onInsert = onInsert
        context.coordinator.onDelete = onDelete
        context.coordinator.onReturn = onReturn
        let keyboardType: UIKeyboardType
        switch kind {
        case "url": keyboardType = .URL
        case "email": keyboardType = .emailAddress
        case "number": keyboardType = .numbersAndPunctuation
        default: keyboardType = .default
        }
        let secure = kind == "password"
        if field.keyboardType != keyboardType || field.isSecureTextEntry != secure {
            field.keyboardType = keyboardType
            field.isSecureTextEntry = secure
            field.returnKeyType = kind == "url" ? .go : .default
            if field.isFirstResponder { field.reloadInputViews() }
        }

        if active && !field.isFirstResponder {
            DispatchQueue.main.async { [weak field] in
                guard let field, field.window != nil else { return }
                _ = field.becomeFirstResponder()
            }
        } else if !active && field.isFirstResponder {
            field.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var onInsert: (String) -> Void
        var onDelete: () -> Void
        var onReturn: () -> Void

        init(onInsert: @escaping (String) -> Void,
             onDelete: @escaping () -> Void,
             onReturn: @escaping () -> Void) {
            self.onInsert = onInsert
            self.onDelete = onDelete
            self.onReturn = onReturn
        }

        func textField(_ textField: UITextField,
                       shouldChangeCharactersIn range: NSRange,
                       replacementString text: String) -> Bool {
            // The field intentionally never retains remote text or passwords.
            // Backspace is handled by the subclass (even for an empty field).
            if !text.isEmpty { onInsert(text) }
            return false
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            onReturn()
            return false
        }
    }
}

final class RemoteKeyboardTextField: UITextField {
    var deleteHandler: (() -> Void)?

    override func deleteBackward() {
        deleteHandler?()
        // There is deliberately no local text to delete. Remote Backspace
        // was emitted, and the app doesn't read back field contents.
    }
}
