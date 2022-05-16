import * as bcrypt from 'bcrypt';
import {
    ForbiddenException,
    Injectable,
    InternalServerErrorException,
} from '@nestjs/common';
import * as i18next from 'i18next';
import { strictEqual as equal } from 'assert';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { AuthServiceRepository } from './auth.repository';
import { userRepository } from '../../db/repositories';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { Utils } from '../../common/utils';
import { appDataSource } from '../../db/dataSource';
import {
    BasicUserData,
    JwtCompleteData,
    UserActivityData,
} from '../../common/types';
import { Jwt } from '../../common/jwt';
import { redisClient } from 'src/common/redis';
import {
    LoggerTemplate,
    UserAction,
    UserTokenType,
    WalletType,
} from 'src/common/enums';
import { UserEntity } from 'src/db/entities';
import { UpdateTokenDto } from './dto/update-token.dto';
import { UserTokenGenerator } from 'src/common/userTokenGenerator';
import { UserActivityLogger } from 'src/common/userActivityLogger';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class AuthService {
    constructor(
        private readonly repository: AuthServiceRepository,
        private readonly configService: ConfigService,
        private readonly walletService: WalletService,
    ) {}

    /**
     * Register a new user by creating appropriate
     * records in the DB
     */
    async signUp(signUpDto: SignUpDto): Promise<void> {
        const memberId = await this.generateMemberId();

        const userData: BasicUserData = {
            memberId,
            email: signUpDto.email,
            password: signUpDto.password,
            status: 1,
        };
        let user: UserEntity;
        await appDataSource.manager.transaction(
            async (transactionalEntityManager: EntityManager) => {
                user = await this.repository.createUser(
                    transactionalEntityManager,
                    userData,
                );
                const city = await this.repository.createCity(
                    transactionalEntityManager,
                    signUpDto.city,
                );
                const userInfoData = {
                    ...signUpDto,
                    user,
                    city,
                };
                await this.repository.createUserInfo(
                    transactionalEntityManager,
                    userInfoData,
                );
            },
        );
        /**
         * Create initial user's wallets
         */
        const tasks = [
            WalletType.US_DOLLAR,
            WalletType.EURO,
            WalletType.GOLD,
        ].map((walletType) => this.walletService.create(walletType, user));
        await Promise.all(tasks);

        const logData: UserActivityData = {
            user,
            action: UserAction.CREATE,
            template: LoggerTemplate.SIGNUP,
            metadata: memberId.toString(),
        };
        await UserActivityLogger.write(logData);
    }

    /**
     * Generate and get a unique "memberId" of
     * the being created user
     */
    private async generateMemberId(): Promise<number> {
        let memberId: number;
        for (let a = 0; a < 100; a++) {
            memberId = +(await Utils.generateRandomString({
                onlyDigits: true,
                length: 7,
            }));
            const user = await userRepository.findOneBy({
                memberId,
            });
            if (!(user instanceof Object)) {
                return memberId;
            }
        }
        throw new InternalServerErrorException(
            i18next.t('unable-to-create-user'),
        );
    }

    /**
     * Login a user using the given 'memberId' and password
     * then return pair of the tokens
     */
    async login(
        { memberId, password }: LoginDto,
        ip: string,
    ): Promise<JwtCompleteData[]> {
        const user = await userRepository.findOneBy({ memberId });
        try {
            equal(user instanceof Object, true);
            const match = await bcrypt.compare(
                password + user.salt,
                user.password,
            );
            if (!match) {
                const seconds = +this.configService.get(
                    'MAX_LOGIN_ATTEMPTS_EXPIRATION',
                );
                const key = `memberId:${memberId}`;
                await redisClient.incr(key);
                await redisClient.expire(key, seconds);
                equal(1, 0);
            }
        } catch {
            throw new ForbiddenException(i18next.t('wrong-credentials'));
        }
        const tokens = await this.generateJwtTokens(user);
        /**
         * Log the executed action
         */
        const logData: UserActivityData = {
            user,
            action: UserAction.LOGIN,
            template: LoggerTemplate.SIGNIN,
            metadata: ip,
        };
        await UserActivityLogger.write(logData);
        return tokens;
    }

    /**
     * Generate and get pair of the 'access-token' and
     * an appropriate 'refresh' one
     */
    private async generateJwtTokens(
        user: UserEntity,
    ): Promise<JwtCompleteData[]> {
        /**
         * Generate refresh token
         */
        const refreshTokenGenerator = new UserTokenGenerator(
            user,
            UserTokenType.REFRESH,
            +this.configService.get('JWT_REFRESH_LIFETIME'),
        );
        await refreshTokenGenerator.generateAndSave();
        await refreshTokenGenerator.sign();
        /**
         * Generate access token
         */
        const accessTokenGenerator = new UserTokenGenerator(
            user,
            UserTokenType.ACCESS,
            +this.configService.get('JWT_ACCESS_LIFETIME'),
            refreshTokenGenerator.record.id,
        );
        await accessTokenGenerator.generateAndSave();
        await accessTokenGenerator.sign();

        return [
            accessTokenGenerator.tokenData,
            refreshTokenGenerator.tokenData,
        ];
    }

    /**
     * Validate the given 'refresh-token' and then
     * generate the new pairs of tokens
     */
    async updateToken({
        refreshToken,
    }: UpdateTokenDto): Promise<JwtCompleteData[]> {
        const data = await Jwt.verify(refreshToken);
        const userToken = await Jwt.findInDb(data);
        const validationOptions = {
            token: userToken,
            type: UserTokenType.REFRESH,
            data,
        };
        Jwt.validate(validationOptions);
        await this.repository.deletePairOfTokens(userToken.id);
        return this.generateJwtTokens(userToken.user);
    }

    /**
     * Disconnect the user from the server and prevent
     * further interaction within the given token
     */
    async logout(accessToken: string, allDevices: boolean): Promise<void> {
        const data = await Jwt.verify(accessToken);
        const userToken = await Jwt.findInDb(data);
        Jwt.validate({
            token: userToken,
            type: UserTokenType.ACCESS,
            data,
        });
        if (allDevices) {
            await this.repository.deleteAllTokens(userToken.user.id);
        } else {
            await this.repository.deletePairOfTokens(userToken.relatedTokenId);
        }
        await UserActivityLogger.write({
            user: userToken.user,
            action: UserAction.LOGOUT,
            template: LoggerTemplate.PLAIN,
        });
    }
}
