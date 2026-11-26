@import Foundation;
@import IOKit;
#include <assert.h>
#include "i2c.h"

int main(void) {
    @autoreleasepool {
        // Synthetic Get VCP reply: input 15, maximum 27, valid checksum.
        UInt8 reply[] = {0x6e, 0x88, 0x02, 0x00, 0x60, 0x00, 0x00, 0x1b, 0x00, 0x0f, 0xc0};
        assert(checkDDCReply(reply, INPUT) == DDC_REPLY_OK);
        @try {
            // Regresses the former sizeof(2) copy beyond each two-byte NSData slice.
            DDCValue value = convertI2CtoDDC((char *)reply);
            assert(value.curValue == 15);
            assert(value.maxValue == 27);
        } @catch (NSException *exception) {
            fprintf(stderr, "DDC decoding raised: %s\n", exception.reason.UTF8String);
            return 1;
        }

        assert(checkDDCReply(reply, CONTRAST) == DDC_REPLY_INVALID);
        reply[10] ^= 1;
        assert(checkDDCReply(reply, INPUT) == DDC_REPLY_INVALID);
        reply[3] = 1; // The changed checksum now matches the unsupported-code reply.
        assert(checkDDCReply(reply, INPUT) == DDC_REPLY_UNSUPPORTED);

        // LG PBP uses standard-source D7, independently of Dell's E9 PBP control.
        assert(LG_PBP != PBP);
        const UInt8 values[] = {1, 2, 5};
        const UInt8 checksums[] = {0x6e, 0x6d, 0x6a};
        for (unsigned int i = 0; i < sizeof(values); i++) {
            DDCPacket packet = createDDCPacket(LG_PBP);
            prepareDDCWrite(&packet, values[i]);
            const UInt8 expected[] = {0x84, 0x03, 0xd7, 0x00, values[i], checksums[i]};
            assert(packet.inputAddr == 0x51);
            assert(memcmp(packet.data, expected, sizeof(expected)) == 0);
        }
    }
    return 0;
}
