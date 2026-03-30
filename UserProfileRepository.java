package com.sherbyte.repository;

import com.sherbyte.model.UserProfile;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Repository
public interface UserProfileRepository extends JpaRepository<UserProfile, String> {

    @Modifying
    @Transactional
    @Query(value = "SELECT update_interest(CAST(:uid AS uuid), :cat, :delta)", nativeQuery = true)
    void updateInterest(@Param("uid") String uid, @Param("cat") String cat, @Param("delta") double delta);

}
