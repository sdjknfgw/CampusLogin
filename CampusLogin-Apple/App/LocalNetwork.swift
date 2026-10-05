import Foundation
import Darwin

enum LocalNetwork {
    static func ipv4(host: String) -> String {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return "" }
        defer { freeifaddrs(head) }
        var pointer = head
        var addresses: [(String, String)] = []
        while let current = pointer {
            let item = current.pointee
            pointer = item.ifa_next
            guard let address = item.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET),
                  (item.ifa_flags & UInt32(IFF_UP)) != 0,
                  (item.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
            let name = String(cString: item.ifa_name)
            // en* covers Wi-Fi and Ethernet; omit cellular and VPN interfaces.
            guard name.hasPrefix("en") else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &buffer,
                           socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: buffer)
                if PortalProfile.isPrivateIPv4(ip) { addresses.append((name, ip)) }
            }
        }
        let prefix = host.split(separator: ".").prefix(3).joined(separator: ".") + "."
        return addresses.first(where: { $0.1.hasPrefix(prefix) })?.1
            ?? addresses.first(where: { $0.0 == "en0" })?.1 ?? addresses.first?.1 ?? ""
    }
}
