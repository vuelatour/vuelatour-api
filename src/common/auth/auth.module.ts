import { Global, Module } from '@nestjs/common';
import { AuthTokenService } from './auth-token.service';

@Global()
@Module({
  providers: [AuthTokenService],
  exports: [AuthTokenService],
})
export class AuthModule {}
