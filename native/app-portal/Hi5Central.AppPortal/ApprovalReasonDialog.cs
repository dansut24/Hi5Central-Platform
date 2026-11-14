using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace Hi5Central.AppPortal;

/// <summary>
/// Unprivileged business-justification prompt for an assigned Company Portal app.
/// This is not the Windows secure-desktop UAC consent screen. No credential is
/// collected and nothing is elevated merely because a request was submitted.
/// </summary>
internal static class ApprovalReasonDialog
{
    private const int MinimumCharacters = 20;
    private const int MaximumCharacters = 2000;

    public static async Task<string?> ShowAsync(Window owner, string applicationName)
    {
        var window = new Window
        {
            Title = "Request administrator approval — Hi5Central",
            Width = 510,
            Height = 370,
            MinWidth = 430,
            MinHeight = 340,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            ShowInTaskbar = false,
            CanResize = true,
            Background = Brushes.White,
        };

        var heading = new TextBlock
        {
            Text = "Why do you need this application?",
            FontWeight = FontWeight.Bold,
            FontSize = 18,
            Foreground = Brushes.Black,
        };
        var explanatory = new TextBlock
        {
            Text = $"Installation of {applicationName} requires administrator approval. "
                + "Explain why you need it. IT will review the request before any installation begins.",
            TextWrapping = TextWrapping.Wrap,
            FontSize = 12,
            Foreground = Brushes.DimGray,
        };
        var reason = new TextBox
        {
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            Watermark = "For example: I need this software to complete a customer project...",
            MinHeight = 110,
            MaxLength = MaximumCharacters,
        };
        var count = new TextBlock
        {
            Text = $"Minimum {MinimumCharacters} characters",
            FontSize = 11,
            Foreground = Brushes.DimGray,
        };
        var submit = new Button
        {
            Content = "Send approval request",
            IsEnabled = false,
            Background = new SolidColorBrush(Color.Parse("#0969DA")),
            Foreground = Brushes.White,
            Padding = new Thickness(15, 9),
        };
        var cancel = new Button
        {
            Content = "Cancel",
            Padding = new Thickness(15, 9),
        };

        reason.TextChanged += (_, _) =>
        {
            var countOfCharacters = reason.Text?.Trim().Length ?? 0;
            submit.IsEnabled = countOfCharacters is >= MinimumCharacters and <= MaximumCharacters;
            count.Text = $"{countOfCharacters} / {MaximumCharacters} characters — "
                + (submit.IsEnabled ? "Ready to request" : $"Minimum {MinimumCharacters} required");
        };

        submit.Click += (_, _) =>
        {
            var suppliedReason = reason.Text?.Trim() ?? string.Empty;
            if (suppliedReason.Length is >= MinimumCharacters and <= MaximumCharacters)
                window.Close(suppliedReason);
        };
        cancel.Click += (_, _) => window.Close(null);

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 10,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        buttons.Children.Add(cancel);
        buttons.Children.Add(submit);

        var panel = new StackPanel
        {
            Spacing = 12,
        };
        panel.Children.Add(heading);
        panel.Children.Add(explanatory);
        panel.Children.Add(reason);
        panel.Children.Add(count);
        panel.Children.Add(buttons);
        window.Content = new Border
        {
            Padding = new Thickness(22),
            Child = panel,
        };

        return await window.ShowDialog<string?>(owner);
    }
}
