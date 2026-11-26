param(
    [ValidateSet('list', 'set', 'set-pbp', 'read-pbp', 'read-input')]
    [string]$Action = 'list',
    [string]$DisplayId,
    [string]$Serial,
    [int]$Value
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    if ($Action -ne 'list') {
        if ([string]::IsNullOrWhiteSpace($DisplayId) -eq [string]::IsNullOrWhiteSpace($Serial)) {
            throw 'Geef precies één DisplayId of Serial op.'
        }
    }
    if ($Action -eq 'set') {
        if ([string]::IsNullOrWhiteSpace($DisplayId)) { throw 'DisplayId is verplicht.' }
        if (-not $PSBoundParameters.ContainsKey('Value') -or $Value -notin @(15, 17, 18, 27)) {
            throw 'Ongeldige ingang. Gebruik 15 (DisplayPort), 17 (HDMI 1), 18 (HDMI 2) of 27 (USB-C).'
        }
    }
    if ($Action -eq 'set-pbp' -and (-not $PSBoundParameters.ContainsKey('Value') -or $Value -notin @(1, 2, 5))) {
        throw 'Ongeldige PBP-waarde. Gebruik 1 (hoofdbeeld), 2 (subbeeld) of 5 (naast elkaar).'
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

public static class LGMonitorDdc
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public uint size;
        public Rect monitor, work;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string device;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public uint size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string description;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string key;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PhysicalMonitor
    {
        public IntPtr handle;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string description;
    }

    public sealed class Monitor
    {
        public string id { get; set; }
        public string name { get; set; }
        public string serial { get; set; }
        public int? vendor { get; set; }
        public int? model { get; set; }
        public uint? currentInput { get; set; }
        public uint? brightness { get; set; }
        public uint? pbpMode { get; set; }
        public string readError { get; set; }
    }

    private sealed class Target
    {
        public Monitor monitor;
        public IntPtr handle;
    }

    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect bounds, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice info, uint flags);

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PhysicalMonitor[] physical);

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyPhysicalMonitors(uint count, [In] PhysicalMonitor[] physical);

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr monitor, byte code, IntPtr type, out uint current, out uint maximum);

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetVCPFeature(IntPtr monitor, byte code, uint value);

    private static Exception WindowsError(string operation)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + ": " + new Win32Exception(code).Message + " (" + code + ")");
    }

    // Only the base EDID block is needed. The ASCII serial descriptor matches
    // m1ddc's AN Serial and survives the display ID changes caused by PBP.
    public static void DecodeIdentity(byte[] edid, Monitor monitor)
    {
        if (edid == null || edid.Length < 128) return;
        byte[] header = { 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00 };
        for (int i = 0; i < header.Length; i++) if (edid[i] != header[i]) return;
        int checksum = 0;
        for (int i = 0; i < 128; i++) checksum += edid[i];
        if ((checksum & 0xff) != 0) return;
        monitor.vendor = (edid[8] << 8) | edid[9];
        monitor.model = edid[10] | (edid[11] << 8);
        for (int offset = 54; offset <= 108; offset += 18)
        {
            if (edid[offset] != 0 || edid[offset + 1] != 0 || edid[offset + 2] != 0 || edid[offset + 3] != 0xff) continue;
            int length = 0;
            while (length < 13 && edid[offset + 5 + length] != 0x0a && edid[offset + 5 + length] != 0)
            {
                byte character = edid[offset + 5 + length];
                if (character < 0x20 || character > 0x7e) return;
                length++;
            }
            string serial = Encoding.ASCII.GetString(edid, offset + 5, length).Trim(' ');
            if (serial.Length > 0) monitor.serial = serial;
            return;
        }
    }

    private static DisplayDevice ActiveDevice(string gdiDevice)
    {
        DisplayDevice? selected = null;
        for (uint index = 0; ; index++)
        {
            DisplayDevice device = new DisplayDevice();
            device.size = (uint)Marshal.SizeOf(typeof(DisplayDevice));
            if (!EnumDisplayDevices(gdiDevice, index, ref device, 1)) break;
            if ((device.flags & 1) == 0) continue; // DISPLAY_DEVICE_ACTIVE
            if (selected.HasValue) throw new InvalidOperationException("Windows koppelt meerdere actieve monitoren aan hetzelfde bureaublad. Gebruik Uitbreiden in plaats van Dupliceren.");
            selected = device;
        }
        if (!selected.HasValue || String.IsNullOrEmpty(selected.Value.id))
            throw new InvalidOperationException("Windows gaf geen unieke actieve monitorinterface terug. Vernieuw de schermlijst.");
        return selected.Value;
    }

    private static void ReadIdentity(string deviceInterface, Monitor monitor)
    {
        // EDD_GET_DEVICE_INTERFACE_NAME: \\?\DISPLAY#hardware-id#instance#{GUID}.
        if (!deviceInterface.StartsWith(@"\\?\DISPLAY#", StringComparison.OrdinalIgnoreCase)) return;
        string[] parts = deviceInterface.Split('#');
        if (parts.Length != 4 || parts[1].Length == 0 || parts[2].Length == 0) return;
        try
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\DISPLAY\" + parts[1] + @"\" + parts[2] + @"\Device Parameters"))
            {
                if (key != null) DecodeIdentity(key.GetValue("EDID") as byte[], monitor);
            }
        }
        catch (System.Security.SecurityException) { }
        catch (UnauthorizedAccessException) { }
        catch (System.IO.IOException) { }
        // Missing/inaccessible EDID leaves serial null. Standard input control
        // still works by device ID; serial-based operations fail closed.
    }

    // Hold this enumeration's handles until selection and the operation finish.
    // This lets serial selection reject duplicates before the first write,
    // without a second enumeration that could target a hotplugged replacement.
    private static void WithMonitors(Action<List<Target>> operation)
    {
        Exception failure = null;
        List<PhysicalMonitor[]> batches = new List<PhysicalMonitor[]>();
        List<Target> targets = new List<Target>();
        MonitorCallback callback = delegate(IntPtr handle, IntPtr dc, ref Rect rect, IntPtr data)
        {
            try
            {
                MonitorInfo info = new MonitorInfo();
                info.size = (uint)Marshal.SizeOf(typeof(MonitorInfo));
                if (!GetMonitorInfo(handle, ref info)) throw WindowsError("GetMonitorInfo");

                uint count;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(handle, out count)) throw WindowsError("GetNumberOfPhysicalMonitorsFromHMONITOR");
                if (count == 0) return true;
                // There is no documented index mapping from multiple physical
                // handles to EnumDisplayDevices entries; never guess an EDID.
                if (count != 1) throw new InvalidOperationException("Windows koppelt meerdere fysieke monitoren aan hetzelfde bureaublad. Gebruik Uitbreiden in plaats van Dupliceren.");
                DisplayDevice device = ActiveDevice(info.device);
                PhysicalMonitor[] physical = new PhysicalMonitor[count];
                if (!GetPhysicalMonitorsFromHMONITOR(handle, count, physical)) throw WindowsError("GetPhysicalMonitorsFromHMONITOR");
                batches.Add(physical);
                if (!String.Equals(ActiveDevice(info.device).id, device.id, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("De monitorverbinding wijzigde tijdens het uitlezen. Vernieuw de schermlijst.");
                for (int i = 0; i < physical.Length; i++)
                {
                    Monitor monitor = new Monitor {
                        id = device.id + "#physical=" + i,
                        name = String.IsNullOrWhiteSpace(physical[i].description) ? device.description : physical[i].description
                    };
                    ReadIdentity(device.id, monitor);
                    targets.Add(new Target { monitor = monitor, handle = physical[i].handle });
                }
                return true;
            }
            catch (Exception ex)
            {
                // Do not let managed exceptions cross the native callback boundary.
                failure = ex;
                return false;
            }
        };
        Exception operationFailure = null;
        try
        {
            bool success = EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
            if (failure != null) throw failure;
            if (!success) throw WindowsError("EnumDisplayMonitors");
            operation(targets);
        }
        catch (Exception ex) { operationFailure = ex; }
        finally
        {
            foreach (PhysicalMonitor[] physical in batches)
            {
                if (!DestroyPhysicalMonitors((uint)physical.Length, physical) && operationFailure == null)
                    operationFailure = WindowsError("DestroyPhysicalMonitors");
            }
        }
        if (operationFailure != null) throw operationFailure;
    }

    private static Target Select(List<Target> targets, string displayId, string serial)
    {
        if (String.IsNullOrWhiteSpace(displayId) == String.IsNullOrWhiteSpace(serial))
            throw new ArgumentException("Geef precies één DisplayId of Serial op.");
        Target selected = null;
        foreach (Target target in targets)
        {
            bool matches = !String.IsNullOrWhiteSpace(serial)
                ? String.Equals(target.monitor.serial, serial, StringComparison.Ordinal)
                : String.Equals(target.monitor.id, displayId, StringComparison.OrdinalIgnoreCase);
            if (!matches) continue;
            if (selected != null) throw new InvalidOperationException("Meerdere schermen hebben dezelfde identificatie. De opdracht is niet verstuurd.");
            selected = target;
        }
        if (selected == null) throw new InvalidOperationException("Het geselecteerde scherm is niet meer aangesloten of de identiteit is niet uit te lezen. Vernieuw de schermlijst.");
        return selected;
    }

    public static Monitor[] List()
    {
        List<Monitor> monitors = new List<Monitor>();
        WithMonitors(delegate(List<Target> targets)
        {
            foreach (Target target in targets)
            {
                Monitor monitor = target.monitor;
                List<string> errors = new List<string>();
                uint current, maximum;
                if (GetVCPFeatureAndVCPFeatureReply(target.handle, 0x60, IntPtr.Zero, out current, out maximum)) monitor.currentInput = current;
                else errors.Add(WindowsError("Ingang uitlezen").Message);
                if (GetVCPFeatureAndVCPFeatureReply(target.handle, 0x10, IntPtr.Zero, out current, out maximum))
                {
                    if (maximum > 0 && current <= maximum) monitor.brightness = (uint)Math.Round(current * 100.0 / maximum);
                    else errors.Add("Het scherm gaf een ongeldige helderheidswaarde terug.");
                }
                else errors.Add(WindowsError("Helderheid uitlezen").Message);
                if (GetVCPFeatureAndVCPFeatureReply(target.handle, 0xd7, IntPtr.Zero, out current, out maximum)) monitor.pbpMode = current;
                else errors.Add(WindowsError("PBP uitlezen").Message);
                monitor.readError = errors.Count == 0 ? null : String.Join("; ", errors.ToArray());
                monitors.Add(monitor);
            }
        });
        return monitors.ToArray();
    }

    public static void SetInput(string displayId, uint value)
    {
        if (String.IsNullOrWhiteSpace(displayId)) throw new ArgumentException("DisplayId is verplicht.");
        if (value != 15 && value != 17 && value != 18 && value != 27) throw new ArgumentOutOfRangeException("value");
        WithMonitors(delegate(List<Target> targets)
        {
            Target target = Select(targets, displayId, null);
            if (!SetVCPFeature(target.handle, 0x60, value)) throw WindowsError("Ingang instellen");
        });
    }

    public static void SetPbp(string displayId, string serial, uint value)
    {
        if (value != 1 && value != 2 && value != 5) throw new ArgumentOutOfRangeException("value");
        WithMonitors(delegate(List<Target> targets)
        {
            Target target = Select(targets, displayId, serial);
            // DXVA2 uses standard DDC source 0x51, required for LG's D7 PBP control.
            if (!SetVCPFeature(target.handle, 0xd7, value)) throw WindowsError("PBP instellen");
        });
    }

    public static uint ReadFeature(string displayId, string serial, bool pbp)
    {
        uint value = 0;
        WithMonitors(delegate(List<Target> targets)
        {
            Target target = Select(targets, displayId, serial);
            uint maximum;
            if (!GetVCPFeatureAndVCPFeatureReply(target.handle, pbp ? (byte)0xd7 : (byte)0x60, IntPtr.Zero, out value, out maximum))
                throw WindowsError(pbp ? "PBP uitlezen" : "Ingang uitlezen");
        });
        return value;
    }
}
'@

    if ($Action -eq 'list') {
        $monitors = @([LGMonitorDdc]::List())
        ConvertTo-Json -InputObject $monitors -Depth 4 -Compress
    } elseif ($Action -eq 'set') {
        [LGMonitorDdc]::SetInput($DisplayId, [uint32]$Value)
        @{ message = 'Schakelopdracht verstuurd. Het scherm bevestigt de nieuwe ingang niet.' } | ConvertTo-Json -Compress
    } elseif ($Action -eq 'set-pbp') {
        [LGMonitorDdc]::SetPbp($DisplayId, $Serial, [uint32]$Value)
        @{ message = 'PBP-opdracht verstuurd. Lees de monitor opnieuw uit om de toestand te controleren.' } | ConvertTo-Json -Compress
    } else {
        @{ value = [LGMonitorDdc]::ReadFeature($DisplayId, $Serial, ($Action -eq 'read-pbp')) } | ConvertTo-Json -Compress
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
