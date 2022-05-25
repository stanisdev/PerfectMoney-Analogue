import { Injectable } from '@nestjs/common';
import {
    FindWalletCriteria,
    TransferData,
    TransferRecord,
    UpdateWalletBalanceData,
} from 'src/common/types';
import { TransferEntity, UserEntity, WalletEntity } from 'src/db/entities';
import { walletRepository } from 'src/db/repositories';
import { EntityManager } from 'typeorm';

@Injectable()
export class TransferServiceRepository {
    getWallet({
        user,
        typeId,
        identifier,
    }: FindWalletCriteria): Promise<WalletEntity> {
        const query = walletRepository
            .createQueryBuilder('wallet')
            .leftJoinAndSelect('wallet.type', 'type')
            .where('wallet."typeId" = :typeId', { typeId })
            .andWhere('wallet.identifier = :identifier', { identifier });
        if (user instanceof UserEntity) {
            query.andWhere('wallet.userId = :userId', { userId: user.id });
        }
        return query.getOne();
    }

    async updateWalletBalance(
        { walletId, balance }: UpdateWalletBalanceData,
        transactionalEntityManager: EntityManager,
    ): Promise<void> {
        await transactionalEntityManager
            .createQueryBuilder()
            .update(WalletEntity)
            .set({ balance })
            .where('id = :id', { id: walletId })
            .execute();
    }

    async createTransfer(
        data: TransferData,
        transactionalEntityManager: EntityManager,
    ): Promise<TransferRecord> {
        const insertedData = await transactionalEntityManager
            .createQueryBuilder()
            .insert()
            .into(TransferEntity)
            .values(data)
            .execute();
        return insertedData.raw[0];
    }
}