# Disposable test window for the computer-use live check (closes itself after 3 minutes).
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WF-CU-Check'; $form.Width = 520; $form.Height = 220; $form.StartPosition = 'CenterScreen'; $form.TopMost = $true
$box = New-Object System.Windows.Forms.TextBox; $box.Name = 'Input'; $box.AccessibleName = 'Input'; $box.Left = 20; $box.Top = 20; $box.Width = 460
$button = New-Object System.Windows.Forms.Button; $button.Text = 'Mark'; $button.AccessibleName = 'Mark'; $button.Left = 20; $button.Top = 60; $button.Width = 120
$label = New-Object System.Windows.Forms.Label; $label.Left = 20; $label.Top = 110; $label.Width = 460; $label.Height = 40; $label.Font = New-Object System.Drawing.Font('Segoe UI', 16); $label.Text = 'Waiting'
$script:clicks = 0
$button.Add_Click({ $script:clicks++; $form.Text = 'Done ' + $script:clicks + ': ' + $box.Text; $label.Text = 'Marked ' + $box.Text })
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 180000; $timer.Add_Tick({ $form.Close() }); $timer.Start()
$form.Controls.AddRange(@($box, $button, $label))
[void]$form.ShowDialog()
