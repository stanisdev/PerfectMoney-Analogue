import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletController } from './wallet.controller';
import { WalletServiceRepository } from './wallet.repository';
import { WalletService } from './wallet.service';

@Module({
    exports: [WalletService],
    controllers: [WalletController],
    providers: [WalletService, WalletServiceRepository, ConfigService],
})
export class WalletModule {}
