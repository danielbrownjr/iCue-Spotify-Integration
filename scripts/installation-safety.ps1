# Side-effect-free per-user install safety helpers. Sourcing this file does not
# install files, register tasks, or inspect Spotify credentials.
function Test-VirtualizedAppDataPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $Normalized = $Path.Replace('/', '\')
    return $Normalized -match '(?i)\\Packages\\[^\\]+\\LocalCache\\Local(?:\\|$)'
}

function Get-PhysicalInstallDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    # Resolve the Windows filesystem handle, not just Get-Item.FullName.
    # MSIX file virtualization can make the logical AppData path misleading.
    if (-not ('IcueSpotifyRealPath' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class IcueSpotifyRealPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetFinalPathNameByHandleW", SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
    public static string Resolve(string path) {
        using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var result = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
            if (length == 0 || length >= result.Capacity)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return result.ToString();
        }
    }
}
'@
    }
    return [IcueSpotifyRealPath]::Resolve($Path)
}

function Assert-RealAppDataInstallDirectory {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    if (Test-VirtualizedAppDataPath $InstallDir) {
        throw 'Refusing packaged/virtualized AppData. Run this installer from normal, non-MSIX PowerShell.'
    }
    $ActualPath = Get-PhysicalInstallDirectory $InstallDir
    if (Test-VirtualizedAppDataPath $ActualPath) {
        throw 'Refusing MSIX-virtualized AppData destination. Run this installer from normal PowerShell.'
    }
    return $ActualPath
}
